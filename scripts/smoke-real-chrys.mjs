#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

const home = await mkdtemp(join(tmpdir(), 'chrys-codex-smoke-'))
const workspace = join(home, 'workspace')
await mkdir(workspace)
await writeFile(join(workspace, 'README.md'), 'Chrys Codex smoke workspace\n')
execFileSync('git', ['init'], { cwd: workspace, stdio: 'ignore' })
execFileSync('git', ['add', 'README.md'], { cwd: workspace })
execFileSync(
  'git',
  ['-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.com', 'commit', '-m', 'init'],
  { cwd: workspace, stdio: 'ignore' },
)
const adapter = resolve('dist/src/adapter.mjs')
const chrys = process.env.CHRYS_CODEX_EXECUTABLE ?? join(process.env.HOME, '.local/bin/chrys')
const sshTarget = process.env.CHRYS_CODEX_SSH_TARGET
const sshIdentity = process.env.CHRYS_CODEX_SSH_IDENTITY
const child = sshTarget
  ? spawn(
      'ssh',
      [
        ...(sshIdentity ? ['-i', sshIdentity] : []),
        '-o',
        'IdentitiesOnly=yes',
        '-o',
        'BatchMode=yes',
        sshTarget,
        `CHRYS_CODEX_HOME=${shellQuote(join(home, 'adapter-home'))} codex app-server --listen stdio://`,
      ],
      { cwd: process.cwd(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'] },
    )
  : spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CODEX_HOME: home,
        CHRYS_CODEX_EXECUTABLE: chrys,
        CHRYS_CODEX_RUNTIME_TYPE: 'chrys-acp',
        NODE_NO_WARNINGS: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
const lines = createInterface({ input: child.stdout })
const queue = []
const waiters = []
lines.on('line', (line) => {
  const message = JSON.parse(line)
  const waiter = waiters.shift()
  if (waiter) waiter(message)
  else queue.push(message)
})
let id = 0
const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
const next = () =>
  queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => waiters.push(resolve))
const request = async (method, params) => {
  const requestId = ++id
  send({ jsonrpc: '2.0', id: requestId, method, params })
  for (;;) {
    const message = await next()
    if (message.id === requestId && !message.method) {
      if (message.error) throw new Error(message.error.message)
      return message.result
    }
    await handleServerRequest(message)
  }
}
const handleServerRequest = async (message) => {
  if (message.id == null || !message.method) return
  if (message.method.endsWith('/requestApproval')) {
    approvalCount += 1
    send({ jsonrpc: '2.0', id: message.id, result: { decision: 'accept' } })
    return
  }
  if (message.method === 'item/tool/requestUserInput') {
    send({ jsonrpc: '2.0', id: message.id, result: { answers: {} } })
    return
  }
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unsupported' } })
}
const waitTurn = async () => {
  let text = ''
  let diff = ''
  for (;;) {
    const message = await next()
    await handleServerRequest(message)
    if (message.method === 'item/agentMessage/delta') text += message.params.delta
    if (message.method === 'turn/diff/updated') diff = message.params.diff
    if (message.method === 'turn/completed') return { text, diff, turn: message.params.turn }
  }
}
let approvalCount = 0

try {
  await request('initialize', {
    clientInfo: { name: 'chrys-codex-smoke', version: '0.1.0' },
    capabilities: null,
  })
  const models = await request('model/list', { limit: 100, cursor: null })
  assert.ok(models.data.some((model) => String(model.displayName).startsWith('Chrys · ')))
  const started = await request('thread/start', {
    cwd: workspace,
    permissions: ':workspace',
  })
  const threadId = started.thread.id
  await request('turn/start', {
    threadId,
    input: [{ type: 'text', text: '只回复 CHRYS_CODEX_ONE，不要调用工具。', text_elements: [] }],
  })
  const first = await waitTurn()
  assert.equal(first.turn.status, 'completed')
  assert.match(first.text, /CHRYS_CODEX_ONE/)
  await request('turn/start', {
    threadId,
    input: [{ type: 'text', text: '只回复 CHRYS_CODEX_TWO，不要调用工具。', text_elements: [] }],
  })
  const second = await waitTurn()
  assert.equal(second.turn.status, 'completed')
  assert.equal(second.text.trim(), 'CHRYS_CODEX_TWO')
  await request('turn/start', {
    threadId,
    input: [
      {
        type: 'text',
        text: "必须调用 shell 工具执行 printf 'CHRYS_DIFF_OK\\n' > chrys-codex-diff.txt，不要使用其他工具。完成后只回复 CHRYS_DIFF_OK。",
        text_elements: [],
      },
    ],
  })
  const third = await waitTurn()
  assert.equal(third.turn.status, 'completed')
  assert.equal(await readFile(join(workspace, 'chrys-codex-diff.txt'), 'utf8'), 'CHRYS_DIFF_OK\n')
  assert.match(third.diff, /chrys-codex-diff\.txt/)
  assert.ok(approvalCount > 0)
  console.log(
    JSON.stringify(
      {
        ok: true,
        threadId,
        models: models.data.length,
        first: first.text,
        second: second.text,
        third: third.text,
        approvalCount,
        diffBytes: third.diff.length,
      },
      null,
      2,
    ),
  )
} finally {
  child.kill('SIGTERM')
  await rm(home, { recursive: true, force: true })
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`
}
