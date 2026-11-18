import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import test from 'node:test'
import { antigravityImage } from '../src/antigravity-input.mjs'
import { antigravityOutputValidator } from '../src/antigravity-output.mjs'
import { CodexClaudeAppServer } from '../src/server.mjs'
import { SessionStore } from '../src/store.mjs'
import type { ClaudeRuntime, RpcPeer, RuntimeTurnContext, WireMessage } from '../src/types.mjs'

test('ACP schema output validates JSON types and required fields before publication', () => {
  const validate = antigravityOutputValidator({
    type: 'json_schema',
    schema: {
      type: 'object',
      properties: { count: { type: 'integer' } },
      required: ['count'],
      additionalProperties: false,
    },
  })!
  validate('{"count":2}')
  assert.throws(() => validate('{"count":"2"}'), /does not match/)
  assert.throws(() => validate('{}'), /does not match/)
  assert.throws(() => validate('```json\n{}\n```'), /invalid JSON/)
})

test('ACP downloads URL images and rejects non-image responses', async () => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', req.url === '/image' ? 'image/png' : 'text/html')
    res.end('image-bytes')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const image = {
    kind: 'url' as const,
    mediaType: '',
    data: `http://127.0.0.1:${port}/image`,
    displayPath: '',
  }
  try {
    assert.deepEqual(await antigravityImage(image, new AbortController().signal), {
      type: 'image',
      data: Buffer.from('image-bytes').toString('base64'),
      mimeType: 'image/png',
    })
    await assert.rejects(
      antigravityImage(
        { ...image, data: `http://127.0.0.1:${port}/html` },
        new AbortController().signal,
      ),
      /must be PNG/,
    )
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('ACP App read-state persists, conflicts on unseen activity, and fork context excludes the current turn', async () => {
  const home = await mkdtemp('/tmp/agy-features-')
  const saved = { ...process.env }
  process.env.CLAUDE_CODEX_RUNTIME_TYPE = 'antigravity-acp'
  process.env.CLAUDE_CODEX_MEMORIES = '1'
  process.env.CLAUDE_CODEX_HOME = home
  delete process.env.CHRYS_CODEX_HOME
  const store = new SessionStore(join(home, 'state.sqlite'))
  const contexts: RuntimeTurnContext[] = []
  const runtime: ClaudeRuntime = {
    runTurn: async (context, handlers) => {
      contexts.push(context)
      await handlers.onEvent({ type: 'session', claudeSessionId: 'fixture-session' })
      await handlers.onEvent({ type: 'text_delta', delta: 'RETAINED_REPLY' })
      await handlers.onEvent({
        type: 'checkpoint',
        claudeSessionId: 'fixture-session',
        messageUuid: `agy-replay:${context.turnId}`,
      })
      await handlers.onEvent({ type: 'completed', success: true, result: 'end_turn' })
    },
    steer: async () => false,
    interrupt: async () => {},
    stop: async () => {},
  }
  const app = new CodexClaudeAppServer(store, runtime)
  const messages: any[] = []
  const peer: RpcPeer = {
    id: 'agy-features',
    close: () => {},
    send: (message: WireMessage) => messages.push(structuredClone(message)),
  }
  let id = 0
  const request = async (method: string, params: unknown): Promise<any> => {
    const requestId = ++id
    await app.handle(peer, { id: requestId, method, params })
    const response = messages.find((message) => message.id === requestId && !message.method)
    if (response.error) throw new Error(response.error.message)
    return response.result
  }
  const turn = async (threadId: string, text: string) => {
    const { turn } = await request('turn/start', { threadId, input: [{ type: 'text', text }] })
    for (let count = 0; count < 200; count++) {
      if (
        messages.some(
          (message) => message.method === 'turn/completed' && message.params.turn.id === turn.id,
        )
      )
        return turn.id
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error('turn timeout')
  }
  let threadId = ''
  try {
    const { thread } = await request('thread/start', { cwd: home, model: 'antigravity/default' })
    threadId = thread.id
    const first = await request('thread/read', { threadId })
    await request('thread/readState/update', {
      threadId,
      operation: { type: 'read' },
      expectedRevision: first.readState.revision,
    })
    await turn(threadId, 'RETAINED_USER')
    await assert.rejects(
      request('thread/readState/update', {
        threadId,
        operation: { type: 'read' },
        expectedRevision: first.readState.revision,
      }),
      /revision conflict/,
    )
    const unread = await request('thread/read', { threadId })
    assert.equal(unread.readState.firstUnread.type, 'turn')
    await request('thread/readState/update', {
      threadId,
      operation: { type: 'read' },
      expectedRevision: unread.readState.revision,
    })
    const fork = await request('thread/fork', { threadId, cwd: home })
    await turn(fork.thread.id, 'CURRENT_USER')
    const context = contexts.at(-1)!
    assert.match(JSON.stringify(context.replayHistory), /RETAINED_USER/)
    assert.doesNotMatch(JSON.stringify(context.replayHistory), /CURRENT_USER/)
    await request('config/value/write', {
      keyPath: 'features.memories',
      value: true,
      mergeStrategy: 'upsert',
    })
    await request('thread/memoryMode/set', { threadId: fork.thread.id, mode: 'enabled' })
    await turn(fork.thread.id, 'MEMORY_CHECK')
    const memory = contexts.at(-1)?.memoryTools
    assert.ok(memory)
    const initialMemory = JSON.parse(await memory.read())
    await memory.write('User explicitly prefers Chinese replies', initialMemory.revision)
    assert.equal(
      (await request('thread/memory/read', { threadId: fork.thread.id })).summary,
      'User explicitly prefers Chinese replies',
    )
    await request('thread/memoryMode/set', { threadId: fork.thread.id, mode: 'disabled' })
    assert.equal((await request('thread/memory/read', { threadId: fork.thread.id })).summary, null)
    await assert.rejects(memory.read(), /disabled/)
    await request('memory/reset', {})
    assert.equal(store.workspaceMemory(home).summary, '')
  } finally {
    await app.stop()
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
  }
  const reopened = new SessionStore(join(home, 'state.sqlite'))
  try {
    assert.equal(reopened.threadReadState(threadId).firstUnread, null)
  } finally {
    reopened.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('adapter workspace memory is isolated, revision checked and durable', async () => {
  const home = await mkdtemp('/tmp/agy-memory-test-')
  const path = join(home, 'state.sqlite')
  let store = new SessionStore(path)
  try {
    const empty = store.workspaceMemory('/workspace/a')
    const saved = store.writeWorkspaceMemory(
      '/workspace/a',
      'Prefer Chinese replies',
      empty.revision,
    )
    assert.throws(
      () => store.writeWorkspaceMemory('/workspace/a', 'stale', empty.revision),
      /revision changed/,
    )
    assert.equal(store.workspaceMemory('/workspace/b').summary, '')
    store.close()
    store = new SessionStore(path)
    assert.deepEqual(store.workspaceMemory('/workspace/a'), saved)
    store.resetWorkspaceMemories()
    assert.equal(store.workspaceMemory('/workspace/a').summary, '')
  } finally {
    store.close()
    await rm(home, { recursive: true, force: true })
  }
})
