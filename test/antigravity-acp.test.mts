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
