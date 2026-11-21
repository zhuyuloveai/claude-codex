import assert from 'node:assert/strict'
import { rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import test from 'node:test'
import { AntigravityBackgroundTasks } from '../src/antigravity-background.mjs'

test('detached jobs stay pending until a matching terminal receipt, including failure', async () => {
  const tasks = new AntigravityBackgroundTasks()
  const task = await tasks.register('delayed check')
  try {
    assert.deepEqual(await tasks.collect(), [])
    assert.equal(tasks.pendingCount, 1)
    await writeFile(`${task.receiptPath}.tmp`, JSON.stringify({ taskId: task.taskId, exitCode: 7 }))
    assert.deepEqual(await tasks.collect(), [])
    await rename(`${task.receiptPath}.tmp`, task.receiptPath)
    assert.equal((await tasks.collect())[0]?.exitCode, 7)
    assert.equal(tasks.pendingCount, 0)
    assert.deepEqual(await tasks.collect(), [])
  } finally {
    await rm(dirname(task.receiptPath), { recursive: true, force: true })
  }
})

test('a receipt from a different task cannot complete tracked work', async () => {
  const tasks = new AntigravityBackgroundTasks()
  const task = await tasks.register('check')
  try {
    await writeFile(task.receiptPath, JSON.stringify({ taskId: 'stale', exitCode: 0 }))
    await assert.rejects(tasks.collect(), /Invalid background task receipt/)
    assert.equal(tasks.pendingCount, 1)
  } finally {
    await rm(dirname(task.receiptPath), { recursive: true, force: true })
  }
})

test('independent runner records real exit code and command output', async () => {
  const { readFile } = await import('node:fs/promises')
  const { setTimeout: delay } = await import('node:timers/promises')
  const tasks = new AntigravityBackgroundTasks()
  const abort = new AbortController()
  const task = await tasks.start('sleep 0.1; printf actual-output; exit 7', '/tmp', abort.signal)
  try {
    let result: Awaited<ReturnType<typeof tasks.collect>> = []
    for (let i = 0; i < 100 && !result.length; i++) {
      result = await tasks.collect()
      if (!result.length) await delay(20)
    }
    assert.equal(result[0]?.exitCode, 7)
    assert.equal(await readFile(task.logPath, 'utf8'), 'actual-output')
  } finally {
    abort.abort()
    await rm(dirname(task.receiptPath), { recursive: true, force: true })
  }
})
