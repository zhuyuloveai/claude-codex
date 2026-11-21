import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, openSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// A receipt belongs to one explicitly registered task, not an arbitrary old
// file. The command runner writes it atomically after the real command exits.
export class AntigravityBackgroundTasks {
  private readonly tasks = new Map<string, { receiptPath: string; description: string }>()

  async register(description: string) {
    const directory = await mkdtemp(join(tmpdir(), 'agy-background-'))
    const taskId = randomUUID()
    const task = { receiptPath: join(directory, 'result.json'), description }
    this.tasks.set(taskId, task)
    return { taskId, ...task }
  }

  async start(command: string, cwd: string, signal: AbortSignal) {
    signal.throwIfAborted()
    const task = await this.register(command)
    const logPath = task.receiptPath + '.log'
    const fd = openSync(logPath, 'a', 0o600)
    try {
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL('./antigravity-background-worker.mjs', import.meta.url)),
          task.taskId,
          task.receiptPath,
          cwd,
          command,
        ],
        { cwd, detached: true, stdio: ['ignore', fd, fd] },
      )
      const cancel = () => {
        if (child.pid && child.exitCode == null) {
          try {
            process.kill(-child.pid, 'SIGTERM')
          } catch {}
        }
      }
      signal.addEventListener('abort', cancel, { once: true })
      child.once('exit', () => signal.removeEventListener('abort', cancel))
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
      })
      if (signal.aborted) cancel()
      child.unref()
      return { ...task, pid: child.pid, logPath }
    } catch (error) {
      this.tasks.delete(task.taskId)
      throw error
    } finally {
      closeSync(fd)
    }
  }

  get pendingTasks() {
    return [...this.tasks].map(([taskId, task]) => ({ taskId, ...task }))
  }

  get pendingCount() {
    return this.tasks.size
  }

  async collect() {
    const completed: {
      taskId: string
      description: string
      exitCode: number
      receiptPath: string
    }[] = []
    for (const [taskId, task] of this.tasks) {
      let text: string
      try {
        text = await readFile(task.receiptPath, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      const result = JSON.parse(text) as { taskId?: string; exitCode?: number }
      if (result.taskId !== taskId || !Number.isInteger(result.exitCode))
        throw new Error(`Invalid background task receipt: ${task.receiptPath}`)
      completed.push({ taskId, ...task, exitCode: result.exitCode! })
      this.tasks.delete(taskId)
    }
    return completed
  }
}
