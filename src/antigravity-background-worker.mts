import { spawn } from 'node:child_process'
import { renameSync, writeFileSync } from 'node:fs'

const [taskId, receiptPath, cwd, command] = process.argv.slice(2)
if (!taskId || !receiptPath || !cwd || !command)
  throw new Error('Missing background runner arguments')
const child = spawn('/bin/bash', ['-c', command], { cwd, stdio: 'inherit' })
let written = false
function finish(exitCode: number) {
  if (written) return
  written = true
  writeFileSync(`${receiptPath}.tmp`, JSON.stringify({ taskId, exitCode }), { mode: 0o600 })
  renameSync(`${receiptPath}.tmp`, receiptPath!)
}
child.on('error', () => finish(127))
child.on('exit', (code) => finish(code ?? 128))
