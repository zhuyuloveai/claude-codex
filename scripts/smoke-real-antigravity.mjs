#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { AcpProcess } from '../dist/src/acp-process.mjs'
import { noteAntigravityModels } from '../dist/src/antigravity-catalog.mjs'

const home = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'agy-codex-smoke-'))
const workspace = join(home, 'workspace')
await mkdir(workspace)
await writeFile(join(workspace, 'README.md'), 'Antigravity adapter disposable smoke workspace\n')
execFileSync('git', ['init'], { cwd: workspace, stdio: 'ignore' })
execFileSync('git', ['add', 'README.md'], { cwd: workspace })
execFileSync(
  'git',
  ['-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.com', 'commit', '-m', 'init'],
  { cwd: workspace, stdio: 'ignore' },
)
const executable =
  process.env.ANTIGRAVITY_CODEX_EXECUTABLE || join(process.env.HOME, '.local/bin/agy')
const stateHome = join(home, 'state')
process.env.CLAUDE_CODEX_HOME = stateHome
delete process.env.CHRYS_CODEX_HOME
const probe = new AcpProcess(
  executable,
  ['acp'],
  workspace,
  () => {},
  async () => {
    throw new Error('Unexpected probe request')
  },
)
try {
  await probe.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: 'codex-antigravity-adapter', version: '0.1.0' },
  })
  noteAntigravityModels(await probe.request('session/new', { cwd: workspace, mcpServers: [] }))
} finally {
  probe.stop()
}

const env = {
  ...process.env,
  CODEX_HOME: stateHome,
  CLAUDE_CODEX_HOME: stateHome,
  CLAUDE_CODEX_RUNTIME_TYPE: 'antigravity-acp',
  ANTIGRAVITY_CODEX_EXECUTABLE: executable,
  CLAUDE_CODEX_DISABLE_CODEX_PROXY: '1',
  CLAUDE_CODEX_PREVENT_IDLE_SLEEP: '0',
  CLAUDE_CODEX_DEFAULT_MODEL:
    process.env.ANTIGRAVITY_CODEX_SMOKE_MODEL || 'antigravity/gemini-3.8-flash',
  CLAUDE_CODEX_EFFORT: 'low',
  CLAUDE_CODEX_MOCK: '0',
  NODE_NO_WARNINGS: '1',
}
delete env.CHRYS_CODEX_HOME
delete env.CHRYS_CODEX_EXECUTABLE
let approvals = 0
let child
let messages = []
let stderr = ''
let nextId = 1
const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
async function waitFor(find, timeout = 180_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const found = find()
    if (found !== undefined) return found
    if (child.exitCode != null) throw new Error(`Adapter exited: ${stderr}`)
    await delay(25)
  }
  throw new Error(
    `Timed out. stderr: ${stderr}; methods: ${messages.map((m) => m.method).join(',')}`,
  )
}
async function request(method, params) {
  const id = nextId++
  send({ jsonrpc: '2.0', id, method, params })
  const response = await waitFor(() => messages.find((m) => m.id === id && !m.method))
  if (response.error) throw new Error(JSON.stringify(response.error))
  return response.result
}
async function start() {
  messages = []
  child = spawn(
    process.execPath,
    [resolve('dist/src/adapter.mjs'), 'app-server', '--listen', 'stdio://'],
    { env, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line)
    messages.push(message)
    if (message.id != null && message.method) {
      if (message.method.endsWith('/requestApproval')) {
        approvals++
        send({ jsonrpc: '2.0', id: message.id, result: { decision: 'accept' } })
      } else {
        send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `unsupported smoke request ${message.method}` },
        })
      }
    }
  })
  await request('initialize', {
    clientInfo: { name: 'antigravity-smoke', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  })
}
async function stop() {
  if (!child || child.exitCode != null) return
  const closed = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGTERM')
  await closed
}
async function turn(threadId, text) {
  const from = messages.length
  const result = await request('turn/start', {
    threadId,
    input: [{ type: 'text', text, text_elements: [] }],
  })
  const finished = await waitFor(() =>
    messages
      .slice(from)
      .find((m) => m.method === 'turn/completed' && m.params.turn.id === result.turn.id),
  )
  assert.equal(finished.params.turn.status, 'completed', JSON.stringify(finished))
  return {
    text: messages
      .slice(from)
      .filter((m) => m.method === 'item/agentMessage/delta')
      .map((m) => m.params.delta)
      .join(''),
    events: messages.slice(from),
  }
}

try {
  await start()
  const models = await request('model/list', {})
  assert.ok(models.data.length > 1)
  assert.ok(models.data.every((m) => m.displayName.startsWith('Antigravity · ')))
  const { thread } = await request('thread/start', {
    cwd: workspace,
    model: env.CLAUDE_CODEX_DEFAULT_MODEL,
    approvalPolicy: 'untrusted',
    sandbox: 'workspace-write',
  })
  assert.equal(thread.modelProvider, 'antigravity')
  const first = await turn(
    thread.id,
    'Remember the code AGY_MEMORY_7319 for our next message. Reply only AGY_ONE. Do not use tools.',
  )
  assert.match(first.text, /AGY_ONE/)
  const before = await request('thread/read', { threadId: thread.id, includeTurns: true })
  await stop()
  await start()
  await request('thread/resume', { threadId: thread.id })
  const second = await turn(
    thread.id,
    'What code did I ask you to remember? Reply with only that code. Do not use tools.',
  )
  assert.match(second.text, /AGY_MEMORY_7319/)
  const third = await turn(
    thread.id,
    "Use your command tool to run exactly: printf 'AGY_DIFF_OK\\n' > agy-smoke.txt . Then reply only AGY_DIFF_OK.",
  )
  assert.equal(await readFile(join(workspace, 'agy-smoke.txt'), 'utf8'), 'AGY_DIFF_OK\n')
  assert.ok(approvals > 0, 'Command approval must reach Codex')
  assert.ok(
    third.events.some(
      (m) => m.method === 'turn/diff/updated' && m.params.diff.includes('agy-smoke.txt'),
    ),
    'File diff must reach Codex',
  )
  const history = await request('thread/read', { threadId: thread.id, includeTurns: true })
  assert.ok(history.thread.turns.length > before.thread.turns.length)
  const report = {
    ok: true,
    home,
    threadId: thread.id,
    models: models.data.length,
    first: first.text,
    resumed: second.text,
    approvals,
    diff: true,
    turns: history.thread.turns.length,
  }
  await writeFile(join(home, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report, null, 2))
} finally {
  await stop()
  console.error(`Evidence: ${home}`)
}
