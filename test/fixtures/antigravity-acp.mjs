import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const scenario = process.argv[2]
const log = process.argv[3]
const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const reply = (id, result) => send({ id, result })
const update = (value) =>
  send({ method: 'session/update', params: { sessionId: 'agy-session', update: value } })
const configOptions = [
  {
    id: 'model',
    category: 'model',
    currentValue: 'gemini-test',
    options: [
      { value: 'gemini-test', name: 'Gemini Test' },
      { value: 'gpt-oss-test', name: 'GPT OSS' },
    ],
  },
  {
    id: 'thought_level',
    category: 'thought_level',
    currentValue: 'medium',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
    ],
  },
  {
    id: 'mode',
    category: 'mode',
    currentValue: 'default',
    options: [{ value: 'default' }, { value: 'plan' }],
  },
]
let promptId
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  appendFileSync(log, `${line}\n`)
  if (message.method === 'initialize')
    return reply(message.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } })
  if (message.method === 'session/new' || message.method === 'session/load') {
    if (message.method === 'session/load')
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'OLD HISTORY' },
      })
    return reply(message.id, { sessionId: 'agy-session', configOptions })
  }
  if (message.method === 'session/set_config_option') return reply(message.id, { configOptions })
  if (message.method === 'session/prompt') {
    if (scenario === 'crash') {
      process.stderr.write('fixture process failure')
      process.exit(7)
    }
    if (promptId) {
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'STEERED' } })
      reply(message.id, { stopReason: 'end_turn' })
      return reply(promptId, { stopReason: 'end_turn' })
    }
    promptId = message.id
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'LIVE' } })
    if (scenario === 'cancel' || scenario === 'steer') return
    const toolCall = {
      sessionUpdate: 'tool_call',
      toolCallId: 'command-1',
      kind: 'execute',
      title: 'printf ok',
      rawInput: { CommandLine: 'printf ok' },
      status: 'pending',
    }
    update(toolCall)
    return send({
      id: 'permission-1',
      method: 'session/request_permission',
      params: {
        sessionId: 'agy-session',
        toolCall,
        options: [
          { optionId: 'yes', kind: 'allow_once' },
          { optionId: 'no', kind: 'reject_once' },
        ],
      },
    })
  }
  if (message.method === 'session/cancel') return reply(promptId, { stopReason: 'cancelled' })
  if (message.id === 'permission-1') {
    const accepted = message.result?.outcome?.optionId === 'yes'
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'command-1',
      status: accepted ? 'completed' : 'failed',
      content: [{ type: 'content', content: { type: 'text', text: accepted ? 'ok' : 'denied' } }],
    })
    return reply(promptId, {
      stopReason: 'end_turn',
      usage: { inputTokens: 11, outputTokens: 2, cachedReadTokens: 3 },
    })
  }
})
