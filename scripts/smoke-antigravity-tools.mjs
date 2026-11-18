#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { AntigravityAcpRuntime } from '../dist/src/antigravity-acp-runtime.mjs'

const home = await mkdtemp('/tmp/agy-tools-smoke-')
process.env.CLAUDE_CODEX_HOME = home
delete process.env.CHRYS_CODEX_HOME
const runtime = new AntigravityAcpRuntime()
const calls = []
const events = []
const context = {
  threadId: 'tools-smoke',
  turnId: 'turn-1',
  cwd: home,
  runtimeType: 'antigravity-acp',
  prompt:
    'Call the Codex bridge verification_probe tool with marker CHECK_BRIDGE. Then call get_goal. Report their exact returned text. You must use the tools, do not guess the result.',
  model: 'antigravity/gemini-3.8-flash',
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
  systemPromptAddendum: null,
  planMode: false,
  imageInputs: [],
  dynamicTools: [
    {
      server: 'codex_app',
      namespace: 'codex_app',
      description: 'Codex App bridge verification',
      tools: [
        {
          name: 'verification_probe',
          description: 'Return verification token. Call with marker CHECK_BRIDGE.',
          inputSchema: {
            type: 'object',
            properties: { marker: { type: 'string' } },
            required: ['marker'],
          },
          deferLoading: false,
        },
      ],
    },
  ],
  goalTools: {
    getGoal: async () => {
      calls.push('get_goal')
      return 'GOAL_BRIDGE_9157'
    },
    createGoal: async () => {
      throw new Error('Not requested')
    },
    updateGoal: async () => {
      throw new Error('Not requested')
    },
  },
}
try {
  await runtime.runTurn(context, {
    onEvent: (event) => {
      events.push(event)
      if (event.type === 'text_delta') process.stdout.write(event.delta)
    },
    onPermissionRequest: async () => ({ decision: 'accept' }),
    onDynamicToolCall: async (request) => {
      assert.equal(request.namespace, 'codex_app')
      assert.equal(request.tool, 'verification_probe')
      assert.equal(request.arguments.marker, 'CHECK_BRIDGE')
      calls.push('verification_probe')
      return { success: true, contentItems: [{ type: 'inputText', text: 'APP_BRIDGE_7319' }] }
    },
  })
  assert.ok(calls.includes('verification_probe'))
  assert.ok(calls.includes('get_goal'))
  assert.ok(events.some((event) => event.type === 'completed' && event.success))
  await writeFile(`${home}/report.json`, JSON.stringify({ home, calls, events }, null, 2))
  console.log(`\nPASS ${home}/report.json`)
} finally {
  await runtime.stop()
}
