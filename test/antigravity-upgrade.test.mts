import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const exec = promisify(execFile)

test('upgrade refuses a busy database and always resumes its briefly frozen daemon', async () => {
  const directory = await mkdtemp('/tmp/agy-upgrade-test-')
  const log = join(directory, 'signals.log')
  try {
    await mkdir(join(directory, 'adapter'))
    await writeFile(
      join(directory, 'launchctl'),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$UPGRADE_TEST_LOG"\n',
      { mode: 0o755 },
    )
    await exec('python3', [
      '-c',
      'import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute("CREATE TABLE turns (status TEXT)");c.execute("INSERT INTO turns VALUES (\'inProgress\')");c.commit()',
      join(directory, 'adapter/state.sqlite'),
    ])
    const installer = await readFile(resolve('scripts/install-antigravity-local.sh'), 'utf8')
    const preflight = installer.slice(
      installer.indexOf('# Freeze the existing daemon'),
      installer.indexOf('# Keep a rollback copy'),
    )
    assert.ok(preflight.includes('SIGSTOP') && preflight.includes('SIGCONT'))
    const probe = join(directory, 'probe.sh')
    await writeFile(
      probe,
      `set -euo pipefail\nSTATE_DIR="$1"\n${preflight}\ntouch "$STATE_DIR/must-not-deploy"\n`,
    )
    await assert.rejects(
      exec('bash', [probe, directory], {
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, UPGRADE_TEST_LOG: log },
      }),
      (error: unknown) => {
        assert.match(String((error as { stderr: string }).stderr), /Refusing upgrade/)
        return true
      },
    )
    const signals = await readFile(log, 'utf8')
    assert.match(signals, /kill SIGSTOP/)
    assert.match(signals, /kill SIGCONT/)
    await assert.rejects(readFile(join(directory, 'must-not-deploy')), { code: 'ENOENT' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
