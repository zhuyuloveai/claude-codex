#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { AntigravityAcpRuntime } from '../dist/src/antigravity-acp-runtime.mjs'

const home = await mkdtemp('/tmp/agy-resume-smoke-')
process.env.CLAUDE_CODEX_HOME = home
delete process.env.CHRYS_CODEX_HOME
const runtime = new AntigravityAcpRuntime()
let sessionId = null
const replies = []
try {
  for (const [index, prompt] of [
    'Remember the token MEMORY_21983 for this conversation. Reply only OLD_REPLY_5471. Do not use tools.',
    'Reply only NEW_REPLY_8317. Do not use tools.',
    'What token did I ask you to remember? Reply only that token. Do not use tools.',
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
        systemPromptAddendum: null,
        planMode: false,
        imageInputs: [],
      },
      {
        onEvent: (event) => {
          if (event.type === 'session') sessionId = event.claudeSessionId
          if (event.type === 'text_delta') text += event.delta
          if (event.type === 'completed') success = event.success
        },
        onPermissionRequest: async () => ({ decision: 'decline' }),
      },
    )
    assert.ok(success)
    replies.push(text.trim())
  }
  assert.deepEqual(replies, ['OLD_REPLY_5471', 'NEW_REPLY_8317', 'MEMORY_21983'])
  await writeFile(`${home}/report.json`, JSON.stringify({ ok: true, replies, sessionId }, null, 2))
  console.log(`PASS ${home}/report.json`)
} finally {
  await runtime.stop()
}
