#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
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
let bridgeCalls = 0
ws.on('message', (data) => {
  const message = JSON.parse(String(data))
  messages.push(message)
  if (message.id != null && message.method === 'item/tool/call') {
    bridgeCalls++
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: { success: true, contentItems: [{ type: 'inputText', text: 'SSH_BRIDGE_84219' }] },
      }),
    )
  }
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
let threadId
try {
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  await request('initialize', {
    clientInfo: { name: 'antigravity-ssh-tool-acceptance', version: '1' },
    capabilities: { experimentalApi: true },
  })
  const { thread } = await request('thread/start', {
    cwd: workspace,
    model: 'antigravity/gemini-3.8-flash',
    approvalPolicy: 'untrusted',
    sandbox: 'workspace-write',
    dynamicTools: [
      {
        namespace: 'codex_app',
        name: 'ssh_verification_probe',
        description: 'Return the SSH tool bridge verification token.',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  })
  threadId = thread.id
  const { turn } = await request('turn/start', {
    threadId,
    input: [
      {
        type: 'text',
        text: 'Call ssh_verification_probe, get_goal, and thread_list with scope children. Reply with the verification token and whether those calls succeeded. Do not create goals, chats or change any files.',
      },
    ],
  })
  const finished = await waitFor(() =>
    messages.find(
      (message) => message.method === 'turn/completed' && message.params.turn.id === turn.id,
    ),
  )
  assert.equal(finished.params.turn.status, 'completed', JSON.stringify(finished))
  const history = await request('thread/read', { threadId, includeTurns: true })
  const items = history.thread.turns.at(-1).items
  const reply = items
    .filter((item) => item.type === 'agentMessage')
    .map((item) => item.text)
    .join('\n')
  assert.ok(bridgeCalls > 0)
  assert.match(reply, /SSH_BRIDGE_84219/)
  assert.ok(history.readState?.revision)
  const report = { ok: true, host, workspace, threadId, bridgeCalls, reply, readState: true }
  await writeFile(join(workspace, 'tool-report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  if (threadId) await request('thread/archive', { threadId }).catch(() => {})
  ws.close()
  proxy.kill('SIGTERM')
}
