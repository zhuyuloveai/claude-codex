import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { acpRecord } from './acp-process.mjs'
import { askRuleCovers } from './ask-rules.mjs'
import { dynamicToolCallResult } from './dynamic-tools.mjs'
import {
  CREATE_GOAL_DESCRIPTION,
  GET_GOAL_DESCRIPTION,
  UPDATE_GOAL_DESCRIPTION,
} from './goal-prompts.mjs'
import {
  THREAD_LIST_DESCRIPTION,
  THREAD_PROMPT_DESCRIPTION,
  THREAD_READ_DESCRIPTION,
  THREAD_START_DESCRIPTION,
  THREAD_WAIT_DESCRIPTION,
} from './leader-tools.mjs'
import { configuredMcpRequest } from './mcp.mjs'
import type { RuntimeHandlers, RuntimeTurnContext } from './types.mjs'

type Tool = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  call(args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
}
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})
const string = { type: 'string' }
const textResult = async (call: () => Promise<string>) => ({
  content: [{ type: 'text', text: await call() }],
})

// A per-turn, owner-only Unix socket exposes only this turn's registered tools.
// The stdio relay is deliberately credential-free; it cannot select another turn.
export async function antigravityToolBridge(
  context: RuntimeTurnContext,
  handlers: RuntimeHandlers,
  signal: AbortSignal,
) {
  const registry = new Map<string, Tool>()
  const add = (tool: Tool) => {
    if (registry.has(tool.name)) throw new Error(`Duplicate bridge tool: ${tool.name}`)
    registry.set(tool.name, tool)
  }
  if (!context.planMode && context.sandboxMode !== 'read-only' && handlers.onDynamicToolCall) {
    for (const server of context.dynamicTools ?? [])
      for (const tool of server.tools) {
        const full = `${server.server}__${tool.name}`
        const name =
          full.length <= 64
            ? full
            : `${full.slice(0, 47)}_${createHash('sha256').update(full).digest('hex').slice(0, 16)}`
        add({
          name,
          description: `${server.description}\n${tool.description}`,
          inputSchema: tool.inputSchema,
          call: async (args, signal) =>
            dynamicToolCallResult(
              await handlers.onDynamicToolCall!(
                {
                  callId: randomUUID(),
                  namespace: server.namespace,
                  tool: tool.name,
                  arguments: args,
                },
                signal,
              ),
            ),
        })
      }
  }
  if (handlers.onUserInputRequest)
    add({
      name: 'request_user_input',
      description:
        'Ask the user one to three concise clarification questions through Codex App. Use only when information is needed; do not use this to approve tool actions.',
      inputSchema: schema(
        {
          questions: {
            type: 'array',
            minItems: 1,
            maxItems: 3,
            items: schema(
              {
                id: string,
                header: string,
                question: string,
                options: {
                  type: 'array',
                  items: schema({ label: string, description: string }, ['label', 'description']),
                },
              },
              ['id', 'header', 'question'],
            ),
          },
        },
        ['questions'],
      ),
      call: async (args, signal) => {
        if (
          !Array.isArray(args.questions) ||
          args.questions.length < 1 ||
          args.questions.length > 3
        )
          throw new Error('Supply 1 to 3 questions')
        const questions = args.questions.map((raw) => {
          const question = acpRecord(raw)
          if (
            typeof question.id !== 'string' ||
            typeof question.header !== 'string' ||
            typeof question.question !== 'string'
          )
            throw new Error('Question id, header and question are required')
          return {
            id: question.id,
            header: question.header,
            question: question.question,
            isOther: true,
            isSecret: false,
            options: Array.isArray(question.options)
              ? question.options.map((raw) => {
                  const option = acpRecord(raw)
                  if (typeof option.label !== 'string' || typeof option.description !== 'string')
                    throw new Error('Invalid option')
                  return { label: option.label, description: option.description }
                })
              : null,
          }
        })
        signal.throwIfAborted()
        const result = await handlers.onUserInputRequest!({
          type: 'user_input_request',
          requestId: randomUUID(),
          toolUseId: randomUUID(),
          questions,
        })
        return { content: [{ type: 'text', text: JSON.stringify(result) }] }
      },
    })
  if (context.sessionChanges)
    add({
      name: 'session_changes',
      description:
        "Read this chat's recorded per-turn file patches. This is not a recomputed net working-tree diff; shell changes may be absent. Use paths or turns to narrow the result.",
      inputSchema: schema({
        paths: { type: 'array', items: string },
        turns: { type: 'integer', minimum: 1 },
        stat: { type: 'boolean' },
      }),
      call: (args) => {
        if (args.turns != null && (!Number.isSafeInteger(args.turns) || Number(args.turns) < 1))
          throw new Error('turns must be positive')
        if (
          args.paths != null &&
          (!Array.isArray(args.paths) || args.paths.some((path) => typeof path !== 'string'))
        )
          throw new Error('paths must be strings')
        return textResult(() =>
          context.sessionChanges!.changes(args, { cwd: context.cwd, configRoots: [] }),
        )
      },
    })
  const memory = context.memoryTools
  if (memory) {
    add({
      name: 'memory_read',
      description:
        'Read the adapter-owned notes for this workspace and their revision. These are separate from Antigravity native memories.',
      inputSchema: schema({}),
      call: () => textResult(() => memory.read()),
    })
    if (!context.planMode && context.sandboxMode !== 'read-only')
      add({
        name: 'memory_update',
        description:
          'Replace this workspace memory with durable preferences or facts the user explicitly asked to remember. Read first, preserve relevant existing notes, and pass the returned revision. Do not store credentials or temporary task progress. Empty summary clears these notes.',
        inputSchema: schema({ summary: string, expectedRevision: string }, [
          'summary',
          'expectedRevision',
        ]),
        call: (args) => {
          if (typeof args.summary !== 'string' || typeof args.expectedRevision !== 'string')
            throw new Error('summary and expectedRevision are required')
          return textResult(() =>
            memory.write(args.summary as string, args.expectedRevision as string),
          )
        },
      })
  }
  const goal = context.goalTools
  if (goal) {
    add({
      name: 'get_goal',
      description: GET_GOAL_DESCRIPTION,
      inputSchema: schema({}),
      call: () => textResult(() => goal.getGoal()),
    })
    add({
      name: 'create_goal',
      description: CREATE_GOAL_DESCRIPTION,
      inputSchema: schema({ objective: string, token_budget: { type: 'integer', minimum: 1 } }, [
        'objective',
      ]),
      call: (args) => {
        if (typeof args.objective !== 'string' || !args.objective.trim())
          throw new Error('objective must be nonempty')
        if (
          args.token_budget != null &&
          (!Number.isSafeInteger(args.token_budget) || Number(args.token_budget) <= 0)
        )
          throw new Error('token_budget must be positive')
        return textResult(() =>
          goal.createGoal(
            args.objective as string,
            args.token_budget == null ? null : Number(args.token_budget),
          ),
        )
      },
    })
    add({
      name: 'update_goal',
      description: UPDATE_GOAL_DESCRIPTION,
      inputSchema: schema({ status: { enum: ['complete', 'blocked', 'paused'] } }, ['status']),
      call: (args) => {
        if (!['complete', 'blocked', 'paused'].includes(String(args.status)))
          throw new Error('Invalid goal status')
        return textResult(() => goal.updateGoal(String(args.status)))
      },
    })
  }
  const leader = context.leaderTools
  if (leader) {
    add({
      name: 'thread_list',
      description: THREAD_LIST_DESCRIPTION,
      inputSchema: schema({ scope: { enum: ['children', 'all'] } }),
      call: (args) => textResult(() => leader.list(args)),
    })
    add({
      name: 'thread_read',
      description: THREAD_READ_DESCRIPTION,
      inputSchema: schema({ threadId: string, sinceCursor: string }, ['threadId']),
      call: (args) =>
        textResult(() =>
          leader.read({
            threadId: String(args.threadId),
            ...(typeof args.sinceCursor === 'string' ? { sinceCursor: args.sinceCursor } : {}),
          }),
        ),
    })
    add({
      name: 'thread_wait',
      description: THREAD_WAIT_DESCRIPTION,
      inputSchema: schema(
        {
          threadIds: { type: 'array', items: string },
          until: { enum: ['any', 'all'] },
          timeoutSec: { type: 'number', minimum: 0, maximum: 3600 },
        },
        ['threadIds'],
      ),
      call: (args, signal) => {
        if (!Array.isArray(args.threadIds) || args.threadIds.some((id) => typeof id !== 'string'))
          throw new Error('threadIds must be strings')
        return textResult(() =>
          leader.wait({ ...args, threadIds: args.threadIds as string[] }, signal),
        )
      },
    })
    if (!context.planMode && context.sandboxMode !== 'read-only') {
      if (leader.stop)
        add({
          name: 'thread_stop',
          description:
            'Stop the running turn of a chat you started with thread_start. Other user chats cannot be stopped by this tool.',
          inputSchema: schema({ threadId: string }, ['threadId']),
          call: (args) => textResult(() => leader.stop!({ threadId: String(args.threadId) })),
        })
      add({
        name: 'thread_start',
        description: THREAD_START_DESCRIPTION.replace('Claude chat', 'Antigravity chat'),
        inputSchema: schema({ prompt: string, cwd: string, model: string, title: string }, [
          'prompt',
        ]),
        call: (args) => {
          if (typeof args.prompt !== 'string' || !args.prompt.trim())
            throw new Error('prompt must be nonempty')
          return textResult(() => leader.start({ ...args, prompt: args.prompt as string }))
        },
      })
      add({
        name: 'thread_prompt',
        description: THREAD_PROMPT_DESCRIPTION,
        inputSchema: schema(
          {
            threadId: string,
            text: string,
            wait: { type: 'boolean' },
            timeoutSec: { type: 'number', minimum: 0, maximum: 3600 },
          },
          ['threadId', 'text'],
        ),
        call: (args, signal) => {
          if (typeof args.threadId !== 'string' || typeof args.text !== 'string')
            throw new Error('threadId and text required')
          return textResult(() =>
            leader.prompt(
              { ...args, threadId: args.threadId as string, text: args.text as string },
              signal,
            ),
          )
        },
      })
    }
  }
  // ACP only advertises stdio MCP. Translate configured HTTP tools through
  // the same local relay; credentials stay in this process, never its argv.
  for (const [name, raw] of Object.entries(acpRecord(context.mcpServers))) {
    const config = acpRecord(raw)
    if (typeof config.url !== 'string' || (config.type && config.type !== 'http')) continue
    try {
      let cursor: unknown
      const seen = new Set<string>()
      for (let page = 0; page < 100; page++) {
        signal.throwIfAborted()
        const listed = acpRecord(
          await configuredMcpRequest(
            name,
            { ...config, type: 'http' },
            'tools/list',
            cursor ? { cursor } : {},
            signal,
          ),
        )
        for (const rawTool of Array.isArray(listed.tools) ? listed.tools : []) {
          const tool = acpRecord(rawTool)
          if (typeof tool.name !== 'string') continue
          const original = tool.name
          const full = `mcp__${name}__${original}`
          const allowed = context.mcpEnabledTools?.[`mcp__${name}__`]
          if (allowed && !allowed.includes(full)) continue
          // Read-only modes cannot trust arbitrary external annotations as a sandbox.
          if (context.planMode || context.sandboxMode === 'read-only') continue
          const alias = `http_${createHash('sha256').update(full).digest('hex').slice(0, 16)}_${original.slice(0, 40)}`
          add({
            name: alias,
            description: `${name}/${original}: ${String(tool.description ?? '')}`,
            inputSchema: acpRecord(tool.inputSchema),
            call: async (args, signal) => {
              signal.throwIfAborted()
              if (
                context.disallowedTools?.some((rule) =>
                  askRuleCovers(rule, full, args, context.cwd),
                )
              )
                throw new Error('Tool denied by configured rule')
              const decision = await handlers.onPermissionRequest({
                type: 'permission_request',
                requestId: randomUUID(),
                toolUseId: randomUUID(),
                toolName: full,
                input: args,
                mcpServer: name,
                reason: `HTTP MCP ${name}/${original}`,
              })
              signal.throwIfAborted()
              if (!['accept', 'acceptForSession'].includes(decision.decision))
                throw new Error('HTTP MCP tool was not approved')
              return configuredMcpRequest(
                name,
                { ...config, type: 'http' },
                'tools/call',
                {
                  name: original,
                  arguments: args,
                },
                signal,
              )
            },
          })
        }
        cursor = listed.nextCursor
        if (!cursor) break
        if (seen.has(String(cursor))) throw new Error('MCP pagination cursor repeated')
        seen.add(String(cursor))
      }
    } catch (error) {
      if (signal.aborted) throw error
      await handlers.onEvent({
        type: 'notice',
        level: 'warning',
        message: `HTTP MCP ${name} could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }
  if (!registry.size) return null
  // /tmp keeps socket paths below macOS's 104-byte limit, regardless of TMPDIR.
  const directory = await mkdtemp('/tmp/agy-tools-')
  await chmod(directory, 0o700)
  const path = join(directory, 'mcp.sock')
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    const pending = new Map<string | number, AbortController>()
    socket.on('error', () => {})
    socket.on('close', () => {
      sockets.delete(socket)
      for (const abort of pending.values()) abort.abort()
    })
    const send = (value: unknown) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`)
    }
    createInterface({ input: socket }).on('line', (line) => {
      void (async () => {
        let message: Record<string, unknown>
        try {
          message = acpRecord(JSON.parse(line))
        } catch {
          return send({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Invalid JSON' },
          })
        }
        const params = acpRecord(message.params)
        if (message.method === 'notifications/cancelled') {
          pending.get(params.requestId as string | number)?.abort()
          return
        }
        if (message.id == null) return
        const id = message.id as string | number
        const response = (result: unknown) => send({ jsonrpc: '2.0', id, result })
        if (message.method === 'initialize')
          return response({
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'codex-antigravity-tools', version: '1.0.0' },
          })
        if (message.method === 'ping') return response({})
        if (message.method === 'tools/list')
          return response({ tools: [...registry.values()].map(({ call: _call, ...spec }) => spec) })
        if (message.method !== 'tools/call')
          return send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } })
        const abort = new AbortController()
        pending.set(id, abort)
        try {
          const tool = registry.get(String(params.name))
          if (!tool) throw new Error('Unknown bridge tool')
          const combined = AbortSignal.any([signal, abort.signal])
          combined.throwIfAborted()
          response(await tool.call(acpRecord(params.arguments), combined))
        } catch (error) {
          response({
            isError: true,
            content: [
              { type: 'text', text: error instanceof Error ? error.message : String(error) },
            ],
          })
        } finally {
          pending.delete(id)
        }
      })().catch(() => socket.destroy())
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, resolve)
    })
    await chmod(path, 0o600)
  } catch (error) {
    server.close()
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  return {
    config: {
      name: 'codex_bridge',
      command: process.execPath,
      args: [fileURLToPath(new URL('./antigravity-mcp-relay.mjs', import.meta.url)), path],
      env: [],
    },
    names: [...registry.keys()],
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    },
  }
}
