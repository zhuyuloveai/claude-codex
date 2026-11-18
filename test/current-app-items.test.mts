import assert from 'node:assert/strict'
import test from 'node:test'
import { scriptedRuntime, withInProcessApp } from './fixtures/in-process-app.mjs'

test('Antigravity helper threads keep the ACP backend even when the App supplies an OpenAI model', async () => {
  const previous = process.env.CLAUDE_CODEX_RUNTIME_TYPE
  process.env.CLAUDE_CODEX_RUNTIME_TYPE = 'antigravity-acp'
  let observedModel: string | null = null
  const runtime = scriptedRuntime(async (context, handlers) => {
    observedModel = context.model
    await handlers.onEvent({ type: 'text_delta', delta: 'Title' })
    await handlers.onEvent({ type: 'completed', success: true, result: 'Title' })
  })
  try {
    await withInProcessApp(
      runtime,
      async (app) => {
        const result = await app.request('thread/start', {
          cwd: app.home,
          ephemeral: true,
          threadSource: 'title_generation',
          model: 'gpt-5',
        })
        assert.equal(result.thread.modelProvider, 'antigravity')
        assert.equal(result.thread.model, 'default')
        const turnId = await app.startTurn(result.thread.id, 'Make a title', { model: 'gpt-5' })
        await app.turnCompleted(turnId)
        assert.equal(observedModel, 'default')
      },
      { env: { CLAUDE_CODEX_MOCK: '0', CLAUDE_CODEX_DISABLE_CODEX_PROXY: '1' } },
    )
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODEX_RUNTIME_TYPE
    else process.env.CLAUDE_CODEX_RUNTIME_TYPE = previous
  }
})

test('current App retrieves selected persisted items in canonical order', async () => {
  const runtime = scriptedRuntime(async (_context, handlers) => {
    await handlers.onEvent({ type: 'text_delta', delta: 'Answer' })
    await handlers.onEvent({ type: 'completed', success: true, result: 'Answer' })
  })
  await withInProcessApp(runtime, async (app) => {
    const threadId = await app.startThread()
    const turnId = await app.startTurn(threadId, 'Question')
    await app.turnCompleted(turnId)
    const history = await app.request('thread/turns/items/list', { threadId, turnId })
    const ids = history.data.map((item: { id: string }) => item.id)
    const read = await app.request('thread/items/read', {
      threadId,
      turnId,
      itemIds: [...ids].reverse(),
    })
    assert.deepEqual(
      read.data.map((entry: { item: { id: string } }) => entry.item.id),
      ids,
    )
    assert.ok(read.data.every((entry: { turnId: string }) => entry.turnId === turnId))
    const invalid = await app.call('thread/items/read', { threadId, turnId, itemIds: [] })
    assert.equal(invalid.error?.code, -32600)
    const missing = await app.call('thread/items/read', {
      threadId,
      turnId: 'missing',
      itemIds: ['item'],
    })
    assert.equal(missing.error?.code, -32600)
  })
})
