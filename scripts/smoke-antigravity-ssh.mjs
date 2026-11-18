#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Duplex } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'

const host = process.env.ANTIGRAVITY_CODEX_SSH_HOST || 'antigravity-local'
const workspace = await mkdtemp('/tmp/agy-ssh-smoke-')
await writeFile(join(workspace, 'README.md'), 'Disposable Antigravity SSH acceptance workspace\n')
execFileSync('git', ['init'], { cwd: workspace, stdio: 'ignore' })
const sshArgs = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host]
execFileSync(
  'ssh',
  [
    ...sshArgs,
    'codex -c features.code_mode_host=true app-server --listen unix:// > "$CODEX_HOME/daemon.log" 2>&1 < /dev/null',
  ],
  { timeout: 20_000 },
)
const proxy = spawn('ssh', [...sshArgs, 'codex app-server proxy'], {
  stdio: ['pipe', 'pipe', 'pipe'],
})
let diagnostic = ''
proxy.stderr.on('data', (chunk) => {
  diagnostic += String(chunk)
})
class ProxyStream extends Duplex {
  constructor() {
    super()
    proxy.stdout.on('data', (chunk) => this.push(chunk))
    proxy.stdout.on('end', () => this.push(null))
    proxy.stdin.on('error', (error) => this.destroy(error))
  }
  _read() {}
  _write(chunk, _encoding, callback) {
    proxy.stdin.write(chunk, callback)
  }
  _final(callback) {
    proxy.stdin.end()
    callback()
  }
}
const ws = new WebSocket('ws://localhost/', { createConnection: () => new ProxyStream() })
const messages = []
let id = 0
let approvals = 0
ws.on('message', (data) => {
  const message = JSON.parse(String(data))
  messages.push(message)
  if (message.id != null && message.method?.endsWith('/requestApproval')) {
    approvals++
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { decision: 'accept' } }))
  }
})
async function waitFor(find, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = find()
    if (result !== undefined) return result
    if (ws.readyState === WebSocket.CLOSED) throw new Error(`SSH proxy closed: ${diagnostic}`)
    await delay(25)
  }
  throw new Error(`SSH acceptance timed out: ${diagnostic}`)
}
async function request(method, params) {
  const requestId = ++id
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }))
  const result = await waitFor(() => messages.find((m) => m.id === requestId && !m.method))
  if (result.error) throw new Error(JSON.stringify(result.error))
  return result.result
}
try {
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const initialized = await request('initialize', {
    clientInfo: { name: 'antigravity-ssh-acceptance', version: '1.0' },
    capabilities: { experimentalApi: true },
  })
  assert.match(initialized.codexHome, /\.antigravity-codex$/)
  assert.match(initialized.userAgent, /antigravity-codex/)
  const models = await request('model/list', {})
  assert.ok(models.data.length > 1)
  assert.ok(models.data.every((m) => m.displayName.startsWith('Antigravity · ')))
  const { thread } = await request('thread/start', {
    cwd: workspace,
    model: 'antigravity/gemini-3.8-flash',
    approvalPolicy: 'untrusted',
    sandbox: 'workspace-write',
  })
  await request('turn/start', {
    threadId: thread.id,
    input: [
      {
        type: 'text',
        text: "Use your command tool to run exactly: printf 'AGY_SSH_OK\\n' > ssh-result.txt . Reply only AGY_SSH_OK.",
        text_elements: [],
      },
    ],
  })
  const finished = await waitFor(() =>
    messages.find((m) => m.method === 'turn/completed' && m.params.threadId === thread.id),
  )
  assert.equal(finished.params.turn.status, 'completed', JSON.stringify(finished))
  assert.equal(await readFile(join(workspace, 'ssh-result.txt'), 'utf8'), 'AGY_SSH_OK\n')
  assert.ok(approvals > 0)
  assert.ok(
    messages.some(
      (m) => m.method === 'turn/diff/updated' && m.params.diff.includes('ssh-result.txt'),
    ),
  )
  const history = await request('thread/read', { threadId: thread.id, includeTurns: true })
  const lastTurn = history.thread.turns.at(-1)
  const items = await request('thread/items/read', {
    threadId: thread.id,
    turnId: lastTurn.id,
    itemIds: lastTurn.items.map((i) => i.id),
  })
  assert.equal(items.data.length, lastTurn.items.length)
  const startIndex = messages.length
  const running = await request('turn/start', {
    threadId: thread.id,
    input: [
      {
        type: 'text',
        text: 'Use your command tool to run sleep 30. Do not use a background task.',
        text_elements: [],
      },
    ],
  })
  await waitFor(() =>
    messages.slice(startIndex).find((m) => m.method?.endsWith('/requestApproval')),
  )
  await delay(250)
  await request('turn/interrupt', { threadId: thread.id, turnId: running.turn.id })
  const cancelled = await waitFor(() =>
    messages
      .slice(startIndex)
      .find((m) => m.method === 'turn/completed' && m.params.turn.id === running.turn.id),
  )
  assert.equal(cancelled.params.turn.status, 'interrupted', JSON.stringify(cancelled))
  await request('thread/archive', { threadId: thread.id })
  const result = {
    ok: true,
    host,
    workspace,
    threadId: thread.id,
    archived: true,
    codexHome: initialized.codexHome,
    models: models.data.length,
    approvals,
    diff: true,
    cancellation: true,
    items: items.data.length,
  }
  await writeFile(join(workspace, 'report.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
} finally {
  ws.close()
  proxy.kill('SIGTERM')
}
