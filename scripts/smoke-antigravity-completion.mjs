#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { AntigravityAcpRuntime } from '../dist/src/antigravity-acp-runtime.mjs'
import { buildSystemPromptAddendum } from '../dist/src/server-helpers.mjs'

const home = await mkdtemp('/tmp/agy-completion-smoke-')
process.env.CLAUDE_CODEX_HOME = home
delete process.env.CHRYS_CODEX_HOME
const runtime = new AntigravityAcpRuntime()
let sessionId = null
const replies = []
try {
  const events = []
  const started = Date.now()
  for (const [index, prompt] of [
    'Run a shell command that sleeps for 35 seconds, then writes TRACKING_DONE_8217 to result.txt in the current directory. Wait for the command to actually finish, read the file with a tool, and report its exact contents. Do not finish with a progress report; do not start duplicate commands.',
  ].entries()) {
    let text = ''
    let success = false
    await runtime.runTurn(
      {
        threadId: 'resume-smoke',
        turnId: `turn-${index}`,
        cwd: home,
        runtimeType: 'antigravity-acp',
        prompt,
        model: 'antigravity/gemini-3.8-flash',
        effort: 'low',
        claudeSessionId: sessionId,
        forkSession: false,
        mcpServers: null,
        allowedTools: null,
        addDirs: [],
        enableFileCheckpointing: false,
        outputFormat: null,
        approvalPolicy: 'untrusted',
        sandboxMode: 'workspace-write',
        systemPromptAddendum: buildSystemPromptAddendum({
          baseInstructions: null,
          developerInstructions: null,
          personality: null,
          desktopPresentation: true,
        }),
        planMode: false,
        imageInputs: [],
      },
      {
        onEvent: (event) => {
          events.push({ at: Date.now(), ...event })
          if (event.type === 'session') sessionId = event.claudeSessionId
          if (event.type === 'text_delta') text += event.delta
          if (event.type === 'completed') success = event.success
        },
        onPermissionRequest: async () => ({ decision: 'accept' }),
      },
    )
    assert.ok(success)
    replies.push(text.trim())
  }
  assert.ok(Date.now() - started >= 35000)
  assert.equal((await readFile(`${home}/result.txt`, 'utf8')).trim(), 'TRACKING_DONE_8217')
  assert.ok(replies[0].includes('TRACKING_DONE_8217'))
  assert.ok(!events.some((e) => e.type === 'tool_result' && e.endedWithTurn))
  const uses = events.filter((e) => e.type === 'tool_use')
  assert.ok(uses.length > 0)
  for (const use of uses)
    assert.ok(events.some((e) => e.type === 'tool_result' && e.toolUseId === use.toolUseId))
  assert.equal(events.at(-1).type, 'completed')
  await writeFile(
    `${home}/report.json`,
    JSON.stringify({ ok: true, replies, sessionId, events }, null, 2),
  )
  console.log(`PASS ${home}/report.json`)
} finally {
  await runtime.stop()
}
