import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { AntigravityAcpRuntime, acpPermissionResponse } from '../src/antigravity-acp-runtime.mjs'
import { antigravityModelOptions } from '../src/antigravity-catalog.mjs'
import { resolveRuntimeConfig } from '../src/runtime-config.mjs'
import type { PermissionDecision, RuntimeEvent, RuntimeTurnContext } from '../src/types.mjs'

function context(cwd: string, overrides: Partial<RuntimeTurnContext> = {}): RuntimeTurnContext {
  return {
    threadId: 'thread',
    turnId: 'turn',
    prompt: 'hello',
    cwd,
    runtimeType: 'antigravity-acp',
    model: 'antigravity/gemini-test',
    effort: 'low',
    claudeSessionId: null,
    forkSession: false,
    mcpServers: null,
    allowedTools: null,
    addDirs: [],
    enableFileCheckpointing: false,
    outputFormat: null,
    approvalPolicy: 'untrusted',
    sandboxMode: 'workspace-write',
    systemPromptAddendum: 'Adapter instruction',
    planMode: false,
    imageInputs: [],
    ...overrides,
  }
}

async function fixture(
  scenario: string,
  body: (runtime: AntigravityAcpRuntime, home: string, log: string) => Promise<void>,
) {
  const home = await mkdtemp(join(tmpdir(), 'agy-test-'))
  const old = process.env.CLAUDE_CODEX_HOME
  process.env.CLAUDE_CODEX_HOME = home
  const log = join(home, 'wire.jsonl')
  const runtime = new AntigravityAcpRuntime({
    command: process.execPath,
    args: [resolve('test/fixtures/antigravity-acp.mjs'), scenario, log],
  })
  try {
    await body(runtime, home, log)
  } finally {
    await runtime.stop()
    if (old === undefined) delete process.env.CLAUDE_CODEX_HOME
    else process.env.CLAUDE_CODEX_HOME = old
    await rm(home, { recursive: true, force: true })
  }
}

test('Antigravity resumes history without replay, preserves models, approvals and event ordering', async () => {
  await fixture('normal', async (runtime, home, log) => {
    const events: RuntimeEvent[] = []
    let approvals = 0
    await runtime.runTurn(context(home, { claudeSessionId: 'agy-session' }), {
      onEvent: async (event) => {
        await delay(2)
        events.push(event)
      },
      onPermissionRequest: async (event) => {
        approvals++
        assert.equal(event.input.command, 'printf ok')
        return { decision: 'accept' }
      },
    })
    assert.equal(approvals, 1)
    assert.equal(
      events
        .filter((e) => e.type === 'text_delta')
        .map((e) => e.delta)
        .join(''),
      'LIVE',
    )
    assert.equal(events.filter((e) => e.type === 'tool_use').length, 1)
    assert.equal(events.at(-1)?.type, 'completed')
    assert.ok(events.some((e) => e.type === 'tool_result' && e.content === 'ok'))
    assert.ok(events.some((e) => e.type === 'usage' && e.usage.input_tokens === 11))
    const messages = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.ok(messages.some((m) => m.method === 'session/load'))
    assert.ok(
      messages.some((m) => m.params?.configId === 'model' && m.params.value === 'gemini-test'),
    )
    assert.ok(
      messages.some((m) => m.params?.configId === 'thought_level' && m.params.value === 'low'),
    )
    assert.ok(antigravityModelOptions().some((m) => m.id === 'antigravity/gpt-oss-test'))
  })
})

test('declining Antigravity permission returns reject_once and preserves failed tool result', async () => {
  await fixture('normal', async (runtime, home, log) => {
    const events: RuntimeEvent[] = []
    await runtime.runTurn(context(home), {
      onEvent: (e) => {
        events.push(e)
      },
      onPermissionRequest: async () => ({ decision: 'decline' }),
    })
    assert.ok(events.some((e) => e.type === 'tool_result' && e.isError && e.content === 'denied'))
    assert.match(await readFile(log, 'utf8'), /"optionId":"no"/)
  })
})

test('Antigravity cancel settles a running prompt', async () => {
  await fixture('cancel', async (runtime, home) => {
    const events: RuntimeEvent[] = []
    await runtime.runTurn(context(home), {
      onEvent: async (e) => {
        events.push(e)
        if (e.type === 'text_delta') await runtime.interrupt('thread')
      },
      onPermissionRequest: async () => ({ decision: 'cancel' }),
    })
    assert.ok(events.some((e) => e.type === 'completed' && !e.success && e.result === 'cancelled'))
  })
})

test('Antigravity steering uses the active ACP session and emits completion after queued events', async () => {
  await fixture('steer', async (runtime, home) => {
    const events: RuntimeEvent[] = []
    await runtime.runTurn(context(home), {
      onEvent: async (e) => {
        events.push(e)
        if (e.type === 'text_delta' && e.delta === 'LIVE')
          assert.equal(await runtime.steer('thread', 'followup'), undefined)
      },
      onPermissionRequest: async () => ({ decision: 'cancel' }),
    })
    assert.equal(
      events
        .filter((e) => e.type === 'text_delta')
        .map((e) => e.delta)
        .join(''),
      'LIVESTEERED',
    )
    assert.equal(events.at(-1)?.type, 'completed')
  })
})

test('Antigravity process failures reject promptly instead of leaving a running turn', async () => {
  await fixture('crash', async (runtime, home) => {
    await assert.rejects(
      runtime.runTurn(context(home), {
        onEvent: () => {},
        onPermissionRequest: async () => ({ decision: 'cancel' }),
      }),
      /fixture process failure/,
    )
  })
})

test('forks cannot silently reuse an Antigravity parent session', async () => {
  const runtime = new AntigravityAcpRuntime()
  await assert.rejects(
    runtime.runTurn(context('/tmp', { forkSession: true, claudeSessionId: 'parent' }), {
      onEvent: () => {},
      onPermissionRequest: async () => ({ decision: 'cancel' }),
    }),
    /forks and rewinds/,
  )
})

test('session approval never becomes a persistent Antigravity allow rule', () => {
  const decision: PermissionDecision = { decision: 'acceptForSession' }
  assert.deepEqual(
    acpPermissionResponse(decision, [{ kind: 'allow_always', optionId: 'forever' }]),
    { outcome: { outcome: 'cancelled' } },
  )
  assert.deepEqual(acpPermissionResponse(decision, [{ kind: 'allow_once', optionId: 'once' }]), {
    outcome: { outcome: 'selected', optionId: 'once' },
  })
})

test('explicit Antigravity wins over inherited Chrys executable configuration', () => {
  assert.equal(
    resolveRuntimeConfig({
      CLAUDE_CODEX_RUNTIME_TYPE: 'antigravity-acp',
      CHRYS_CODEX_EXECUTABLE: '/bin/chrys',
    }).type,
    'antigravity-acp',
  )
  assert.equal(resolveRuntimeConfig({ CHRYS_CODEX_EXECUTABLE: '/bin/chrys' }).type, 'chrys-acp')
})

test('Antigravity forks reconstruct only retained App history in a new session', async () => {
  await fixture('normal', async (runtime, home, log) => {
    const events: RuntimeEvent[] = []
    await runtime.runTurn(
      context(home, {
        claudeSessionId: 'parent',
        forkSession: true,
        resumeSessionAt: 'agy-replay:old',
        replayHistory: [
          {
            type: 'agentMessage',
            id: 'old',
            text: 'RETAINED_ONLY',
            phase: null,
            memoryCitation: null,
          },
        ],
      }),
      {
        onEvent: (event) => {
          events.push(event)
        },
        onPermissionRequest: async () => ({ decision: 'accept' }),
      },
    )
    const wire = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.ok(wire.some((message) => message.method === 'session/new'))
    assert.ok(!wire.some((message) => message.method === 'session/load'))
    assert.match(
      JSON.stringify(wire.find((message) => message.method === 'session/prompt')),
      /RETAINED_ONLY/,
    )
    assert.ok(events.some((event) => event.type === 'checkpoint'))
    assert.ok(events.some((event) => event.type === 'notice'))
  })
})

test('Antigravity compaction commits a fresh session only after successful summary and seeding', async () => {
  await fixture('normal', async (runtime, home, log) => {
    const events: RuntimeEvent[] = []
    await runtime.runTurn(context(home, { prompt: '/compact', claudeSessionId: 'parent' }), {
      onEvent: (event) => {
        events.push(event)
      },
      onPermissionRequest: async () => ({ decision: 'accept' }),
    })
    const wire = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(wire.filter((message) => message.method === 'session/load').length, 1)
    assert.equal(wire.filter((message) => message.method === 'session/new').length, 1)
    assert.equal(events.filter((event) => event.type === 'session').length, 1)
    assert.ok(events.some((event) => event.type === 'compaction_completed'))
  })
})

test('Antigravity in-flight effort uses ACP and rejects an unavailable level', async () => {
  await fixture('steer', async (runtime, home) => {
    let ready!: () => void
    const started = new Promise<void>((resolve) => {
      ready = resolve
    })
    const running = runtime.runTurn(context(home), {
      onEvent: (event) => {
        if (event.type === 'text_delta' && event.delta === 'LIVE') ready()
      },
      onPermissionRequest: async () => ({ decision: 'cancel' }),
    })
    await started
    assert.equal(await runtime.updateTurnSettings('thread', 'turn', { effort: 'medium' }), true)
    await assert.rejects(
      runtime.updateTurnSettings('thread', 'turn', { effort: 'max' }),
      /does not offer reasoning effort/,
    )
    await runtime.steer('thread', 'finish')
    await running
  })
})

test('Antigravity deny rules win even if the App approval handler would accept', async () => {
  await fixture('normal', async (runtime, home, log) => {
    await runtime.runTurn(context(home, { disallowedTools: ['Bash'] }), {
      onEvent: () => {},
      onPermissionRequest: async () => {
        throw new Error('deny rule must not ask')
      },
    })
    assert.match(await readFile(log, 'utf8'), /"optionId":"no"/)
  })
})

test('Antigravity auto-compacts only from explicit ACP context occupancy', async () => {
  await fixture('usage', async (runtime, home, log) => {
    const events: RuntimeEvent[] = []
    const handlers = {
      onEvent: (event: RuntimeEvent) => {
        events.push(event)
      },
      onPermissionRequest: async () => ({ decision: 'accept' as const }),
    }
    await runtime.runTurn(context(home), handlers)
    events.length = 0
    await runtime.runTurn(
      context(home, { claudeSessionId: 'agy-session', autoCompactWindow: 100000, turnId: 'next' }),
      handlers,
    )
    assert.ok(
      events.some((event) => event.type === 'compaction_completed' && event.trigger === 'auto'),
    )
    assert.equal(events.filter((event) => event.type === 'completed').length, 1)
    const wire = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(wire.filter((message) => message.method === 'session/prompt').length, 4)
  })
})
