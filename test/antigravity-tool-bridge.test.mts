import assert from 'node:assert/strict'
import { stat } from 'node:fs/promises'
import test from 'node:test'
import { AcpProcess } from '../src/acp-process.mjs'
import { antigravityToolBridge } from '../src/antigravity-tool-bridge.mjs'
import type { RuntimeTurnContext } from '../src/types.mjs'

const context = (extra: Partial<RuntimeTurnContext> = {}): RuntimeTurnContext => ({
  threadId: 'bridge-thread',
  turnId: 'turn',
  cwd: '/tmp',
  runtimeType: 'antigravity-acp',
  prompt: '',
  model: null,
  effort: null,
  claudeSessionId: null,
  forkSession: false,
  mcpServers: null,
  allowedTools: null,
  addDirs: [],
  enableFileCheckpointing: false,
  outputFormat: null,
  approvalPolicy: 'untrusted',
  sandboxMode: 'workspace-write',
  systemPromptAddendum: null,
  planMode: false,
  imageInputs: [],
  ...extra,
})

test('ACP stdio bridge round-trips long App tool names, errors, goals and cancellation', async () => {
  const abort = new AbortController()
  let request: unknown
  const tool = 'a'.repeat(100)
  const bridge = await antigravityToolBridge(
    context({
      dynamicTools: [
        {
          server: 'app',
          namespace: 'app',
          description: '',
          tools: [
            {
              name: tool,
              description: 'Echo',
              inputSchema: { type: 'object' },
              deferLoading: false,
            },
          ],
        },
      ],
      goalTools: {
        getGoal: async () => 'goal',
        createGoal: async (objective) => objective,
        updateGoal: async () => {
          throw new Error('not completed')
        },
      },
    }),
    {
      onEvent: () => {},
      onPermissionRequest: async () => ({ decision: 'cancel' }),
      onDynamicToolCall: async (input, signal) => {
        request = input
        if ((input.arguments as { wait?: boolean }).wait)
          await new Promise<void>((_resolve, reject) =>
            signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
          )
        return { success: true, contentItems: [{ type: 'inputText', text: 'APP_OK' }] }
      },
    },
    abort.signal,
  )
  assert.ok(bridge)
  const socketPath = bridge.config.args[1]!
  assert.equal((await stat(socketPath)).mode & 0o777, 0o600)
  const client = new AcpProcess(
    bridge.config.command,
    bridge.config.args,
    '/tmp',
    () => {},
    async () => ({}),
  )
  try {
    const initialized = (await client.request('initialize', {})) as { capabilities: unknown }
    assert.ok(initialized.capabilities)
    const listed = (await client.request('tools/list', {})) as { tools: { name: string }[] }
    const alias = listed.tools.find((entry) => entry.name.startsWith('app__'))!.name
    assert.ok(alias.length <= 64)
    assert.deepEqual(
      await client.request('tools/call', { name: alias, arguments: { value: 42 } }),
      { content: [{ type: 'text', text: 'APP_OK' }] },
    )
    assert.equal((request as { tool: string }).tool, tool)
    assert.deepEqual(await client.request('tools/call', { name: 'get_goal' }), {
      content: [{ type: 'text', text: 'goal' }],
    })
    assert.equal(
      (
        (await client.request('tools/call', {
          name: 'update_goal',
          arguments: { status: 'complete' },
        })) as { isError: boolean }
      ).isError,
      true,
    )
    const waiting = client.request('tools/call', { name: alias, arguments: { wait: true } })
    const timer = setTimeout(() => abort.abort(), 30)
    assert.equal(((await waiting) as { isError: boolean }).isError, true)
    clearTimeout(timer)
  } finally {
    client.stop()
    await bridge.close()
  }
  await assert.rejects(stat(socketPath), { code: 'ENOENT' })
})

test('read-only ACP sessions never expose arbitrary App actions', async () => {
  const bridge = await antigravityToolBridge(
    context({
      planMode: true,
      dynamicTools: [
        {
          server: 'app',
          namespace: 'app',
          description: '',
          tools: [{ name: 'write', description: '', inputSchema: {}, deferLoading: false }],
        },
      ],
    }),
    {
      onEvent: () => {},
      onPermissionRequest: async () => ({ decision: 'cancel' }),
      onDynamicToolCall: async () => {
        throw new Error('must not call')
      },
    },
    new AbortController().signal,
  )
  assert.equal(bridge, null)
})

test('ACP HTTP MCP forwarding uses configured headers and checks approval before execution', async () => {
  const { createServer } = await import('node:http')
  let executed = 0
  let approved = false
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer fixture-only')
    let body = ''
    for await (const chunk of req) body += chunk
    const message = JSON.parse(body)
    if (!message.id) {
      res.writeHead(204)
      res.end()
      return
    }
    let result: unknown = {}
    if (message.method === 'initialize')
      result = {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'http-fixture', version: '1' },
      }
    if (message.method === 'tools/list')
      result = {
        tools: [{ name: 'echo', description: 'HTTP echo', inputSchema: { type: 'object' } }],
      }
    if (message.method === 'tools/call') {
      executed++
      result = { content: [{ type: 'text', text: 'HTTP_OK' }] }
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const bridge = await antigravityToolBridge(
    context({
      mcpServers: {
        remote: {
          type: 'http',
          url: `http://127.0.0.1:${port}`,
          headers: { Authorization: 'Bearer fixture-only' },
        },
      },
    }),
    {
      onEvent: () => {},
      onPermissionRequest: async () => ({ decision: approved ? 'accept' : 'decline' }),
    },
    new AbortController().signal,
  )
  assert.ok(bridge)
  const client = new AcpProcess(
    bridge.config.command,
    bridge.config.args,
    '/tmp',
    () => {},
    async () => ({}),
  )
  try {
    const name = bridge.names[0]
    assert.equal(
      ((await client.request('tools/call', { name, arguments: {} })) as { isError: boolean })
        .isError,
      true,
    )
    assert.equal(executed, 0)
    approved = true
    assert.deepEqual(await client.request('tools/call', { name, arguments: {} }), {
      content: [{ type: 'text', text: 'HTTP_OK' }],
    })
    assert.equal(executed, 1)
    assert.doesNotMatch(JSON.stringify(bridge.config), /fixture-only/)
  } finally {
    client.stop()
    await bridge.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
