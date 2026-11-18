import { type AcpMessage, AcpProcess, acpRecord, acpText } from './acp-process.mjs'
import {
  acpConfigOptions,
  acpSelectOptions,
  noteAntigravityModels,
} from './antigravity-catalog.mjs'
import type {
  ClaudeRuntime,
  PermissionDecision,
  RuntimeHandlers,
  RuntimeSteerOptions,
  RuntimeTurnContext,
} from './types.mjs'

interface ActiveTurn {
  client: AcpProcess
  sessionId: string
  abort: AbortController
  steering: Promise<unknown>[]
}

// ACP is the supported integration surface; no editor identity impersonation,
// private language-server API, or credential extraction is needed.
export class AntigravityAcpRuntime implements ClaudeRuntime {
  private readonly active = new Map<string, ActiveTurn>()
  private readonly command: string
  private readonly args: string[]

  constructor(options: { command?: string; args?: string[] } = {}) {
    this.command = options.command ?? process.env.ANTIGRAVITY_CODEX_EXECUTABLE ?? 'agy'
    this.args = options.args ?? ['acp']
  }

  async runTurn(context: RuntimeTurnContext, handlers: RuntimeHandlers): Promise<void> {
    if (this.active.has(context.threadId))
      throw new Error('Antigravity thread already has an active turn')
    // Never load the parent's live conversation for a fork: ACP support must be
    // negotiated before a genuine fork can safely share its history.
    if (context.forkSession || context.resumeSessionAt)
      throw new Error(
        'Antigravity ACP history forks and rewinds are not supported by this adapter yet; start a new chat.',
      )
    const abort = new AbortController()
    const tools = new Map<
      string,
      { name: string; input: Record<string, unknown>; emitted: boolean; ended: boolean }
    >()
    let sessionId = context.claudeSessionId ?? ''
    let live = false
    const client = new AcpProcess(
      this.command,
      this.args,
      context.cwd,
      async (message) => {
        if (message.method !== 'session/update') return
        const params = acpRecord(message.params)
        if (sessionId && params.sessionId !== sessionId) return
        const update = acpRecord(params.update)
        if (update.sessionUpdate === 'config_option_update') noteAntigravityModels(update)
        if (!live) return // session/load may replay history already in the App store
        const kind = update.sessionUpdate
        if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
          await handlers.onEvent({
            type: kind === 'agent_message_chunk' ? 'text_delta' : 'reasoning_delta',
            delta: acpText(update.content),
          })
        } else if (kind === 'tool_call' || kind === 'tool_call_update') {
          const id = String(update.toolCallId ?? '')
          if (!id) return
          const previous = tools.get(id)
          const normalized = antigravityTool(update)
          const state = {
            name:
              normalized.name === 'Antigravity tool'
                ? (previous?.name ?? normalized.name)
                : normalized.name,
            input: Object.keys(normalized.input).length
              ? normalized.input
              : (previous?.input ?? {}),
            emitted: previous?.emitted ?? false,
            ended: previous?.ended ?? false,
          }
          tools.set(id, state)
          if (!state.emitted) {
            state.emitted = true
            await handlers.onEvent({
              type: 'tool_use',
              toolUseId: id,
              toolName: state.name,
              input: state.input,
            })
          }
          if (!state.ended && (update.status === 'completed' || update.status === 'failed')) {
            state.ended = true
            await handlers.onEvent({
              type: 'tool_result',
              toolUseId: id,
              content: acpText(update.content) || update.rawOutput || '',
              isError: update.status === 'failed',
            })
          }
        } else if (kind === 'usage_update') {
          // ACP's used/size are context occupancy, not per-turn token usage.
          // Only forward explicit token counts; don't fabricate usage from size.
          const usage = acpRecord(update.usage)
          if (Object.keys(usage).length) await handlers.onEvent({ type: 'usage', usage })
        }
      },
      async (message) => this.reverseRequest(message, handlers, abort.signal),
    )
    const active: ActiveTurn = { client, sessionId, abort, steering: [] }
    this.active.set(context.threadId, active)
    try {
      const initialized = acpRecord(
        await client.request('initialize', {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: 'codex-antigravity-adapter', version: '0.1.0' },
        }),
      )
      const capabilities = acpRecord(initialized.agentCapabilities)
      if (sessionId && capabilities.loadSession !== true)
        throw new Error(
          'This Antigravity CLI does not advertise session/load; cannot safely restore this chat.',
        )
      const session = acpRecord(
        await client.request(sessionId ? 'session/load' : 'session/new', {
          cwd: context.cwd,
          mcpServers: acpMcpServers(context.mcpServers),
          ...(sessionId ? { sessionId } : {}),
        }),
      )
      sessionId = String(session.sessionId ?? sessionId)
      if (!sessionId) throw new Error('Antigravity ACP returned no session id')
      active.sessionId = sessionId
      noteAntigravityModels(session)
      await this.configure(client, sessionId, session, context)
      await handlers.onEvent({ type: 'session', claudeSessionId: sessionId })
      if (abort.signal.aborted) return
      live = true
      const text = [
        context.systemPromptAddendum,
        ...(context.promptContext ?? []),
        context.prompt,
        context.outputFormat
          ? `Return only JSON matching this output format:\n${JSON.stringify(context.outputFormat)}`
          : null,
      ]
        .filter(Boolean)
        .join('\n\n')
      const prompt: unknown[] = [{ type: 'text', text }]
      for (const image of context.imageInputs) {
        if (image.kind === 'base64')
          prompt.push({ type: 'image', data: image.data, mimeType: image.mediaType })
      }
      const result = acpRecord(
        await client.request('session/prompt', { sessionId, prompt }, 2 * 60 * 60_000),
      )
      await Promise.all(active.steering)
      for (const [id, tool] of tools) {
        if (!tool.ended)
          await handlers.onEvent({
            type: 'tool_result',
            toolUseId: id,
            content: 'Turn ended before the tool completed',
            isError: true,
            endedWithTurn: true,
          })
      }
      const usage = acpRecord(result.usage)
      if (Object.keys(usage).length)
        await handlers.onEvent({
          type: 'usage',
          usage: {
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            reasoning_output_tokens: usage.thoughtTokens,
            cache_read_input_tokens: usage.cachedReadTokens,
            cache_creation_input_tokens: usage.cachedWriteTokens,
          },
        })
      const stopReason = String(result.stopReason ?? '')
      await handlers.onEvent({
        type: 'completed',
        claudeSessionId: sessionId,
        result: stopReason,
        success: stopReason === 'end_turn' && !abort.signal.aborted,
      })
    } finally {
      abort.abort()
      this.active.delete(context.threadId)
      client.stop()
    }
  }

  async steer(
    threadId: string,
    prompt: string,
    options?: RuntimeSteerOptions,
  ): Promise<boolean | undefined> {
    const active = this.active.get(threadId)
    if (!active?.sessionId || active.abort.signal.aborted) return false
    const request = active.client.request(
      'session/prompt',
      {
        sessionId: active.sessionId,
        prompt: [{ type: 'text', text: prompt }],
      },
      2 * 60 * 60_000,
    )
    // Keep errors attached until runTurn awaits them; no unhandled rejection.
    void request.catch(() => {})
    active.steering.push(request)
    // ACP acknowledges this request only when the prompt completes. Until
    // then we cannot promise the running model has consumed the new input.
    void request.then(() => options?.onAccepted?.()).catch(() => {})
    return undefined
  }

  async interrupt(threadId: string): Promise<void> {
    const active = this.active.get(threadId)
    if (!active) return
    active.abort.abort()
    if (active.sessionId) active.client.notify('session/cancel', { sessionId: active.sessionId })
    else active.client.stop()
    const timer = setTimeout(() => {
      if (this.active.get(threadId) === active) active.client.stop()
    }, 5000)
    timer.unref()
  }

  async stop(): Promise<void> {
    for (const active of this.active.values()) {
      active.abort.abort()
      active.client.stop()
    }
    this.active.clear()
  }

  private async configure(
    client: AcpProcess,
    sessionId: string,
    session: Record<string, unknown>,
    context: RuntimeTurnContext,
  ): Promise<void> {
    let configs = acpConfigOptions(session)
    const requestedModel = context.model?.replace(/^antigravity\//, '')
    const model = configs.find((option) => option.category === 'model' || option.id === 'model')
    if (requestedModel && requestedModel !== 'default') {
      if (model) {
        if (!acpSelectOptions(model).some((option) => option.value === requestedModel))
          throw new Error(`Antigravity does not offer model ${context.model} to this ACP client`)
        const changed = acpRecord(
          await client.request('session/set_config_option', {
            sessionId,
            configId: model.id,
            value: requestedModel,
          }),
        )
        noteAntigravityModels(changed)
        configs = acpConfigOptions(changed)
      } else {
        await client.request('session/set_model', { sessionId, modelId: requestedModel })
      }
    }
    const mode = configs.find((option) => option.category === 'mode')
    if (mode)
      await client.request('session/set_config_option', {
        sessionId,
        configId: mode.id,
        value: context.planMode || context.sandboxMode === 'read-only' ? 'plan' : 'default',
      })
    const effort = configs.find((option) =>
      /thought|think|reason|effort/i.test(`${option.category} ${option.id} ${option.name}`),
    )
    if (effort && context.effort) {
      const wanted = context.effort
      const selected = acpSelectOptions(effort).find(
        (option) =>
          String(option.value).toLowerCase() === wanted ||
          String(option.name).toLowerCase() === wanted ||
          (wanted === 'xhigh' && option.value === 'extra'),
      )
      if (selected)
        await client.request('session/set_config_option', {
          sessionId,
          configId: effort.id,
          value: selected.value,
        })
    }
  }

  private async reverseRequest(
    message: AcpMessage,
    handlers: RuntimeHandlers,
    signal: AbortSignal,
  ): Promise<unknown> {
    const params = acpRecord(message.params)
    if (message.method === 'session/request_permission') {
      if (signal.aborted) return { outcome: { outcome: 'cancelled' } }
      const call = acpRecord(params.toolCall)
      const tool = antigravityTool(call)
      const decision = await handlers.onPermissionRequest({
        type: 'permission_request',
        requestId: String(message.id),
        toolUseId: String(call.toolCallId ?? message.id),
        toolName: tool.name,
        input: tool.input,
        reason: String(call.title ?? 'Antigravity requests permission'),
      })
      return acpPermissionResponse(
        signal.aborted ? { decision: 'cancel' } : decision,
        params.options,
      )
    }
    if (message.method === 'elicitation/create') {
      if (!handlers.onElicitationRequest || signal.aborted) return { action: 'cancel' }
      return handlers.onElicitationRequest(
        {
          serverName: 'Antigravity',
          message: String(params.message ?? ''),
          mode: 'form',
          requestedSchema: acpRecord(params.requestedSchema),
          url: null,
          elicitationId: null,
        },
        signal,
      )
    }
    throw new Error(`Unsupported Antigravity ACP request: ${message.method}`)
  }
}

export function acpPermissionResponse(decision: PermissionDecision, rawOptions: unknown): unknown {
  const options = Array.isArray(rawOptions) ? rawOptions.map(acpRecord) : []
  // "For session" must not silently create a persistent Antigravity allow rule.
  const kind =
    decision.decision === 'accept' || decision.decision === 'acceptForSession'
      ? 'allow_once'
      : decision.decision === 'decline'
        ? 'reject_once'
        : null
  const option = options.find((entry) => entry.kind === kind)
  return option?.optionId
    ? { outcome: { outcome: 'selected', optionId: option.optionId } }
    : { outcome: { outcome: 'cancelled' } }
}

export function antigravityTool(update: Record<string, unknown>): {
  name: string
  input: Record<string, unknown>
} {
  const input = { ...acpRecord(update.rawInput) }
  const hint = `${update.kind ?? ''} ${update.title ?? ''}`.toLowerCase()
  const command = input.command ?? input.CommandLine ?? input.command_line ?? input.cmd
  const locations = Array.isArray(update.locations) ? update.locations.map(acpRecord) : []
  const path =
    input.file_path ?? input.TargetFile ?? input.AbsolutePath ?? input.path ?? locations[0]?.path
  if (path != null) input.file_path = path
  if (typeof command === 'string') input.command = command
  const diffs = Array.isArray(update.content)
    ? update.content.map(acpRecord).filter((part) => part.type === 'diff')
    : []
  if (diffs[0]) {
    input.file_path = diffs[0].path ?? path
    input.old_string = diffs[0].oldText ?? ''
    input.new_string = diffs[0].newText ?? ''
  }
  if (typeof command === 'string' || /execute|command|terminal|bash/.test(hint))
    return { name: 'Bash', input }
  if (/edit|patch|replace/.test(hint) || diffs.length) return { name: 'Edit', input }
  if (/write|create/.test(hint))
    return { name: 'Write', input: { ...input, content: input.CodeContent ?? input.content } }
  if (/read/.test(hint)) return { name: 'Read', input }
  if (/search/.test(hint)) return { name: 'Grep', input }
  return { name: String(update.title ?? update.kind ?? 'Antigravity tool'), input }
}

function acpMcpServers(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  return Object.entries(acpRecord(raw)).flatMap(([name, value]) => {
    const config = acpRecord(value)
    if (typeof config.command === 'string')
      return [
        {
          name,
          command: config.command,
          args: Array.isArray(config.args) ? config.args : [],
          env: Object.entries(acpRecord(config.env)).map(([name, value]) => ({
            name,
            value: String(value),
          })),
        },
      ]
    return [] // HTTP MCP requires a different agy process mode; don't guess.
  })
}
