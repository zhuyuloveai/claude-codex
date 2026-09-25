#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const checks = []
const add = (name, ok, detail) => checks.push({ name, ok, detail })
const nodeMajor = Number(process.versions.node.split('.')[0])
add('node', nodeMajor >= 24, process.version)

const chrys = process.env.CHRYS_CODEX_EXECUTABLE ?? 'chrys'
try {
  const version = execFileSync(chrys, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim()
  add('chrys', true, `${chrys}: ${version}`)
  const models = JSON.parse(
    execFileSync(chrys, ['models', '--json'], { encoding: 'utf8', timeout: 10_000 }),
  )
  add(
    'chrys-models',
    Array.isArray(models.models) && models.models.length > 0,
    `${models.models?.length ?? 0} model(s)`,
  )
} catch (error) {
  add('chrys', false, error instanceof Error ? error.message : String(error))
}

const adapter = resolve('dist/src/adapter.mjs')
add('adapter-build', existsSync(adapter), adapter)
for (const check of checks)
  console.log(`${check.ok ? 'OK' : 'FAIL'} ${check.name}: ${check.detail}`)
if (checks.some((check) => !check.ok)) process.exitCode = 1
