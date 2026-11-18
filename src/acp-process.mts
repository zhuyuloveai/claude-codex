import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export interface AcpMessage {
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string }
}

export const acpRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

export const acpText = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(acpText).filter(Boolean).join('\n')
  const record = acpRecord(value)
  if (typeof record.text === 'string') return record.text
  return record.content == null ? '' : acpText(record.content)
}

// Notifications are ordered, while reverse requests remain concurrent: waiting
// for a permission response must not prevent cancellation or a prompt result.
export class AcpProcess {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<
    number,
    {
      resolve(value: unknown): void
      reject(error: Error): void
      timer: NodeJS.Timeout
    }
  >()
  private nextId = 1
  private closed = false
  private notifications: Promise<void> = Promise.resolve()
  private diagnostic = ''

  constructor(
    command: string,
    args: string[],
    cwd: string,
    privateNotification: (message: AcpMessage) => Promise<void> | void,
    privateRequest: (message: AcpMessage) => Promise<unknown>,
  ) {
    this.child = spawn(command, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stderr.on('data', (chunk) => {
      this.diagnostic = (this.diagnostic + String(chunk)).slice(-2000)
    })
    this.child.stdin.on('error', (error) => this.fail(error))
    this.child.once('error', (error) => this.fail(error))
    this.child.once('exit', (code, signal) => {
      this.fail(new Error(`ACP process exited (${signal ?? code}): ${this.diagnostic.trim()}`))
    })
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      let message: AcpMessage
      try {
        message = JSON.parse(line) as AcpMessage
      } catch {
        return
      }
      if (message.method && message.id != null) {
        void privateRequest(message).then(
          (result) => this.write({ jsonrpc: '2.0', id: message.id, result }),
          (error) =>
            this.write({
              jsonrpc: '2.0',
              id: message.id,
              error: {
                code: -32603,
                message: error instanceof Error ? error.message : String(error),
              },
            }),
        )
      } else if (message.method) {
        this.notifications = this.notifications.then(() => privateNotification(message))
        void this.notifications.catch((error: Error) => this.fail(error))
      } else if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        // Deliver all preceding events before reporting a completed prompt.
        void this.notifications.then(() => {
          if (message.error)
            pending.reject(new Error(message.error.message ?? 'ACP request failed'))
          else pending.resolve(message.result)
        }, pending.reject)
      }
    })
  }

  async request(method: string, params: unknown, timeoutMs = 120_000): Promise<unknown> {
    if (this.closed) throw new Error('ACP process is closed')
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`ACP request timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  stop(): void {
    this.fail(new Error('ACP process stopped'))
    if (this.child.exitCode == null) {
      this.child.kill('SIGTERM')
      const timer = setTimeout(() => {
        if (this.child.exitCode == null) this.child.kill('SIGKILL')
      }, 3000)
      timer.unref()
    }
  }

  private write(message: unknown): void {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private fail(error: Error): void {
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
