#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { AcpProcess } from '../dist/src/acp-process.mjs'

const home = await mkdtemp('/tmp/agy-features-smoke-')
Object.assign(process.env, {
  CODEX_HOME: home,
  CLAUDE_CODEX_HOME: `${home}/state`,
  CLAUDE_CODEX_RUNTIME_TYPE: 'antigravity-acp',
  CLAUDE_CODEX_DYNAMIC_TOOLS: '1',
  CLAUDE_CODEX_LEADER_TOOLS: '1',
  CLAUDE_CODEX_DISABLE_CODEX_PROXY: '1',
})
delete process.env.CHRYS_CODEX_HOME
const messages = []
let bridgeCalls = 0
const app = new AcpProcess(
  process.execPath,
  [
    fileURLToPath(new URL('../dist/src/adapter.mjs', import.meta.url)),
    'app-server',
    '--listen',
    'stdio://',
  ],
  home,
  (message) => {
    messages.push(message)
  },
  async (message) => {
    if (message.method === 'item/tool/call') {
      bridgeCalls++
      return { success: true, contentItems: [{ type: 'inputText', text: 'APP_RPC_31729' }] }
    }
    if (message.method?.endsWith('/requestApproval')) return { decision: 'accept' }
    throw new Error(`Unexpected server request ${message.method}`)
  },
)
const request = (method, params) => app.request(method, params, 180_000)
const wait = async (predicate) => {
  for (let i = 0; i < 9000; i++) {
    const found = predicate()
    if (found) return found
    await delay(20)
  }
  throw new Error('acceptance timeout')
}
const turn = async (threadId, text) => {
  const { turn } = await request('turn/start', { threadId, input: [{ type: 'text', text }] })
  const completed = await wait(() =>
    messages.find(
      (message) => message.method === 'turn/completed' && message.params.turn.id === turn.id,
    ),
  )
  assert.equal(completed.params.turn.status, 'completed', JSON.stringify(completed))
  const history = await request('thread/read', { threadId, includeTurns: true })
  const reply = history.thread.turns
    .at(-1)
    .items.filter((item) => item.type === 'agentMessage')
    .map((item) => item.text)
    .join('\n')
  console.log(JSON.stringify({ threadId, turnId: turn.id, reply }))
  return { id: turn.id, reply }
}
const threads = []
try {
  await request('initialize', {
    clientInfo: { name: 'agy-feature-acceptance', version: '1' },
    capabilities: { experimentalApi: true },
  })
  const { thread } = await request('thread/start', {
    cwd: home,
    model: 'antigravity/gemini-3.8-flash',
    approvalPolicy: 'untrusted',
    sandbox: 'workspace-write',
    dynamicTools: [
      {
        namespace: 'codex_app',
        name: 'verification_probe',
        description: 'Return an App RPC verification token.',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  })
  threads.push(thread.id)
  const first = await turn(
    thread.id,
    'Remember RETAINED_5173. Call verification_probe and report its exact returned token. Also call get_goal and thread_list with scope all to verify the integration tools. Do not create goals or chats.',
  )
  assert.ok(bridgeCalls > 0)
  assert.match(first.reply, /APP_RPC_31729/)
  const firstRead = await request('thread/read', { threadId: thread.id })
  assert.ok(firstRead.readState.firstUnread)
  const marked = await request('thread/readState/update', {
    threadId: thread.id,
    operation: { type: 'read' },
    expectedRevision: firstRead.readState.revision,
  })
  assert.equal(marked.readState.firstUnread, null)
  await turn(thread.id, 'The newer secret is DROPPED_9821. Reply OK.')
  const fork = await request('thread/fork', {
    threadId: thread.id,
    lastTurnId: first.id,
    cwd: home,
  })
  threads.push(fork.thread.id)
  const remembered = await turn(
    fork.thread.id,
    'What was the RETAINED token? Also is there a newer secret in the conversation history? Quote it only if known. Do not call tools or inspect files.',
  )
  assert.match(remembered.reply, /RETAINED_5173/)
  assert.doesNotMatch(remembered.reply, /DROPPED_9821/)
  await request('thread/rollback', { threadId: thread.id, numTurns: 1 })
  const rolled = await turn(
    thread.id,
    'What was the RETAINED token? Is there a newer secret in your conversation history? Quote it only if known. Do not use tools or read files.',
  )
  assert.match(rolled.reply, /RETAINED_5173/)
  assert.doesNotMatch(rolled.reply, /DROPPED_9821/)
  const before = messages.length
  await request('thread/compact/start', { threadId: fork.thread.id })
  await wait(() =>
    messages
      .slice(before)
      .find(
        (message) =>
          message.method === 'thread/compacted' && message.params.threadId === fork.thread.id,
      ),
  )
  const afterCompact = await turn(
    fork.thread.id,
    'What was the RETAINED token? Reply only that token. No tools.',
  )
  assert.match(afterCompact.reply, /RETAINED_5173/)
  const report = {
    ok: true,
    home,
    bridgeCalls,
    fork: true,
    rollback: true,
    compact: true,
    readState: true,
    threads,
  }
  await writeFile(`${home}/report.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  for (const threadId of threads) await request('thread/archive', { threadId }).catch(() => {})
  app.stop()
}
