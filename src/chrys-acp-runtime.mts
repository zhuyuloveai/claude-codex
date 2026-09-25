import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type {
  ClaudeRuntime,
  PermissionDecision,
  RuntimeHandlers,
  RuntimeTurnContext,
  UserInputAnswers,
  UserInputQuestion,
} from './types.mjs'

interface JsonRpcMessage {
  id?: string | number | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { message?: string }
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

interface ActiveChrysTurn {
  client: AcpProcess
  sessionId: string
}

interface AcpToolState {
  emitted: boolean
  title: string
  input: Record<string, unknown>
  content: unknown
  rawOutput: unknown
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const textContent = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textContent).filter(Boolean).join('\n')
  const record = asRecord(value)
  if (typeof record.text === 'string') return record.text
  if (record.content != null) return textContent(record.content)
  return ''
}

function normalizedToolName(update: Record<string, unknown>): string {
  const rawInput = asRecord(update.rawInput)
  const hint = `${String(update.kind ?? '')} ${String(update.title ?? '')}`.toLowerCase()
  if (/shell|terminal|command|bash/.test(hint) || typeof rawInput.command === 'string')
    return 'Bash'
  if (/write|create/.test(hint)) return 'Write'
  if (/edit|patch|replace/.test(hint)) return 'Edit'
  if (/read/.test(hint)) return 'Read'
  if (/grep|search/.test(hint)) return 'Grep'
  return String(update.title ?? update.kind ?? 'Chrys tool')
}

function normalizedToolInput(update: Record<string, unknown>): Record<string, unknown> {
  const input = asRecord(update.rawInput)
  const command = input.command ?? input.cmd
  if (typeof command === 'string') return { ...input, command }
  const filePath = input.file_path ?? input.path ?? input.filename
  return filePath == null ? input : { ...input, file_path: String(filePath) }
}

class AcpProcess {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<string | number, PendingRequest>()
  private nextId = 1
  private closed = false
  private readonly onNotification: (message: JsonRpcMessage) => Promise<void> | void
  private readonly onRequest: (message: JsonRpcMessage) => Promise<unknown>

  constructor(
    command: string,
    args: string[],
    cwd: string,
    onNotification: (message: JsonRpcMessage) => Promise<void> | void,
    onRequest: (message: JsonRpcMessage) => Promise<unknown>,
  ) {
    this.onNotification = onNotification
    this.onRequest = onRequest
    this.child = spawn(command, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    const lines = createInterface({ input: this.child.stdout })
    lines.on('line', (line) => this.receive(line))
    this.child.stderr.on('data', () => {})
    this.child.once('error', (error) => this.failAll(error))
    this.child.once('exit', (code, signal) => {
      if (!this.closed) this.failAll(new Error(`Chrys ACP exited (${signal ?? code ?? 'unknown'})`))
    })
  }

  async request(method: string, params: unknown, timeoutMs = 120_000): Promise<unknown> {
    if (this.closed) throw new Error('Chrys ACP process is closed')
    const id = this.nextId++
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Chrys ACP request timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
    })
    this.write({ jsonrpc: '2.0', id, method, params })
    return response
  }

  notify(method: string, params: unknown): void {
    if (!this.closed) this.write({ jsonrpc: '2.0', method, params })
  }

  stop(): void {
    if (this.closed) return
    this.closed = true
    this.child.kill('SIGTERM')
    this.failAll(new Error('Chrys ACP process stopped'))
  }

  private write(message: unknown): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private receive(line: string): void {
    let message: JsonRpcMessage
    try {
      message = JSON.parse(line) as JsonRpcMessage
    } catch {
      return
    }
    if (message.method && message.id != null) {
      void this.onRequest(message).then(
        (result) => this.write({ jsonrpc: '2.0', id: message.id, result }),
        (error) =>
          this.write({
            jsonrpc: '2.0',
            id: message.id,
            error: {
              code: -32000,
              message: error instanceof Error ? error.message : String(error),
            },
          }),
      )
      return
    }
    if (message.method) {
      void this.onNotification(message)
      return
    }
    if (message.id == null) return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.error)
      pending.reject(new Error(message.error.message ?? 'Chrys ACP request failed'))
    else pending.resolve(message.result)
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

export class ChrysAcpRuntime implements ClaudeRuntime {
  private readonly active = new Map<string, ActiveChrysTurn>()
  private readonly command: string
  private readonly agent: string

  constructor(options: { command?: string; agent?: string } = {}) {
    this.command = options.command ?? process.env.CHRYS_CODEX_EXECUTABLE ?? 'chrys'
    this.agent = options.agent ?? process.env.CHRYS_CODEX_AGENT ?? 'Code'
  }

  async runTurn(context: RuntimeTurnContext, handlers: RuntimeHandlers): Promise<void> {
    if (this.active.has(context.threadId))
      throw new Error('Chrys thread already has an active turn')
    const tools = new Map<string, AcpToolState>()
    let sessionId = context.claudeSessionId
    let live = false
    const client = new AcpProcess(
      this.command,
      ['acp', '--agent', this.agent, '--approval', 'manual', '--workdir', context.cwd],
      context.cwd,
      async (message) => {
        if (message.method !== 'session/update') return
        const params = asRecord(message.params)
        if (sessionId && params.sessionId !== sessionId) return
        // session/load replays historical updates. Codex already has those in
        // its own store, so only project updates emitted by the new prompt.
        if (!live) return
        const update = asRecord(params.update)
        const kind = String(update.sessionUpdate ?? '')
        if (kind === 'agent_message_chunk') {
          await handlers.onEvent({ type: 'text_delta', delta: textContent(update.content) })
          return
        }
        if (kind === 'agent_thought_chunk') {
          await handlers.onEvent({ type: 'reasoning_delta', delta: textContent(update.content) })
          return
        }
        if (kind === 'usage_update') {
          await handlers.onEvent({ type: 'usage', usage: update })
          return
        }
        if (kind !== 'tool_call' && kind !== 'tool_call_update') return
        const toolUseId = String(update.toolCallId ?? '')
        if (!toolUseId) return
        const previous = tools.get(toolUseId)
        const state: AcpToolState = {
          emitted: previous?.emitted ?? false,
          title: normalizedToolName(update),
          input: Object.keys(normalizedToolInput(update)).length
            ? normalizedToolInput(update)
            : (previous?.input ?? {}),
          content: update.content ?? previous?.content,
          rawOutput: update.rawOutput ?? previous?.rawOutput,
        }
        tools.set(toolUseId, state)
        if (!state.emitted) {
          state.emitted = true
          await handlers.onEvent({
            type: 'tool_use',
            toolUseId,
            toolName: state.title,
            input: state.input,
          })
        }
        if (update.status === 'completed' || update.status === 'failed') {
          const content = textContent(state.content) || state.rawOutput || ''
          await handlers.onEvent({
            type: 'tool_result',
            toolUseId,
            content,
            isError: update.status === 'failed',
          })
        }
      },
      async (message) => {
        const params = asRecord(message.params)
        if (message.method === 'session/request_permission') {
          const toolCall = asRecord(params.toolCall)
          const toolUseId = String(toolCall.toolCallId ?? `permission-${Date.now()}`)
          const decision = await handlers.onPermissionRequest({
            type: 'permission_request',
            requestId: String(message.id),
            toolUseId,
            toolName: normalizedToolName(toolCall),
            input: normalizedToolInput(toolCall),
          })
          return permissionResponse(decision, params.options)
        }
        if (message.method === '_chrys/request_input') return questionResponse(params, handlers)
        throw new Error(`Unsupported Chrys ACP request: ${message.method}`)
      },
    )
    try {
      await client.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'chrys-codex-adapter', version: '0.1.0' },
      })
      const sessionResult = asRecord(
        await client.request(sessionId ? 'session/load' : 'session/new', {
          cwd: context.cwd,
          mcpServers: Array.isArray(context.mcpServers) ? context.mcpServers : [],
          ...(sessionId ? { sessionId } : {}),
        }),
      )
      sessionId = String(sessionResult.sessionId ?? sessionId ?? '')
      if (!sessionId) throw new Error('Chrys ACP returned no session id')
      await selectModel(client, sessionId, context.model)
      this.active.set(context.threadId, { client, sessionId })
      await handlers.onEvent({ type: 'session', claudeSessionId: sessionId })
      const prompt = [
        ...(context.prompt ? [{ type: 'text', text: context.prompt }] : []),
        ...context.imageInputs
          .filter((image) => image.kind === 'base64')
          .map((image) => ({ type: 'image', data: image.data, mimeType: image.mediaType })),
      ]
      live = true
      const result = asRecord(
        await client.request('session/prompt', { sessionId, prompt }, 2 * 60 * 60_000),
      )
      const cancelled = result.stopReason === 'cancelled'
      await handlers.onEvent({
        type: 'completed',
        claudeSessionId: sessionId,
        result: String(result.stopReason ?? ''),
        success: !cancelled,
      })
    } finally {
      this.active.delete(context.threadId)
      client.stop()
    }
  }

  async steer(): Promise<void> {
    throw new Error('Chrys ACP does not expose turn steering')
  }

  async interrupt(threadId: string): Promise<void> {
    const active = this.active.get(threadId)
    if (active) active.client.notify('session/cancel', { sessionId: active.sessionId })
  }

  async stop(): Promise<void> {
    for (const active of this.active.values()) active.client.stop()
    this.active.clear()
  }
}

function permissionResponse(decision: PermissionDecision, rawOptions: unknown): unknown {
  const options = Array.isArray(rawOptions) ? rawOptions.map(asRecord) : []
  const kinds =
    decision.decision === 'acceptForSession'
      ? ['allow_always', 'allow_once']
      : decision.decision === 'accept'
        ? ['allow_once', 'allow_always']
        : decision.decision === 'decline'
          ? ['reject_once', 'reject_always']
          : []
  const selected = kinds.flatMap((kind) => options.filter((option) => option.kind === kind)).at(0)
  return selected?.optionId
    ? { outcome: { outcome: 'selected', optionId: selected.optionId } }
    : { outcome: { outcome: 'cancelled' } }
}

async function questionResponse(
  params: Record<string, unknown>,
  handlers: RuntimeHandlers,
): Promise<unknown> {
  const rawQuestions = Array.isArray(params.questions) ? params.questions.map(asRecord) : []
  const questions: UserInputQuestion[] = rawQuestions.map((question, index) => ({
    id: `q_${index}`,
    header: String(question.header ?? params.callerName ?? 'Chrys'),
    question: String(question.question ?? ''),
    isOther: !Array.isArray(question.options) || question.options.length === 0,
    isSecret: false,
    options: Array.isArray(question.options)
      ? question.options.map((option) => {
          const value = asRecord(option)
          return { label: String(value.label ?? ''), description: String(value.description ?? '') }
        })
      : null,
  }))
  if (!handlers.onUserInputRequest) return { answers: [], cancelled: true }
  const stamp = Date.now()
  const response: UserInputAnswers = await handlers.onUserInputRequest({
    type: 'user_input_request',
    requestId: `chrys-question-${stamp}`,
    toolUseId: `chrys-question-${stamp}`,
    questions,
  })
  const answers = questions.map((question) => {
    const answer = response.answers[question.id]
    return { values: answer?.answers ?? [], note: answer?.notes ?? '' }
  })
  return { answers, cancelled: answers.some((answer) => answer.values.length === 0) }
}

async function selectModel(
  client: AcpProcess,
  sessionId: string,
  model: string | null,
): Promise<void> {
  if (!model || model === 'default') return
  await client.request('session/set_model', { sessionId, modelId: model })
}
