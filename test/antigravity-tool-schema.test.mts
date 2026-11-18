import assert from 'node:assert/strict'
import test from 'node:test'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { antigravityToolSchema } from '../src/antigravity-tool-schema.mjs'

const pattern =
  '^(?![0-9a-f]{4,}$)(?!(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$)[a-z0-9]+(?:-[a-z0-9]+)*$'
test('App worktree regex is advertised without RE2-incompatible syntax but enforced before dispatch', () => {
  const original = {
    type: 'object',
    properties: {
      name: { type: 'string', maxLength: 64, pattern },
      ref: { type: 'string', pattern: '^[^-]' },
    },
    required: ['ref'],
    additionalProperties: false,
  }
  const adapted = antigravityToolSchema(original)
  const properties = adapted.schema.properties as Record<string, Record<string, unknown>>
  assert.equal(properties.name?.pattern, undefined)
  assert.equal(properties.name?.maxLength, 64)
  assert.match(String(properties.name?.description), /ECMAScript/)
  assert.equal(original.properties.name.pattern, pattern)
  adapted.validate({ name: 'fix-tool-schema', ref: 'HEAD' })
  for (const name of ['deadbeef', 'con', 'com1', 'Bad Name'])
    assert.throws(() => adapted.validate({ name, ref: 'HEAD' }), /original App schema/)
  assert.throws(() => adapted.validate({ name: 'valid', ref: '--delete' }), /original App schema/)
  assert.throws(() => adapted.validate({ name: 'valid' }), /original App schema/)
})

test('nested schema projection does not change literal data and widens negation/oneOf safely', () => {
  const original = {
    type: 'object',
    properties: {
      nested: { anyOf: [{ type: 'string', pattern: '(?=ok)ok' }, { type: 'null' }] },
      literal: { const: { pattern: 'DATA' } },
      unique: {
        oneOf: [
          { type: 'string', pattern: '^a' },
          { type: 'string', pattern: '^b' },
        ],
      },
      negative: { not: { pattern: '^bad' } },
    },
  }
  const adapted = antigravityToolSchema(original)
  const validateProjection = new Ajv2020({ strict: false }).compile(adapted.schema)
  const valid = { nested: 'ok', literal: { pattern: 'DATA' }, unique: 'apple', negative: 'good' }
  adapted.validate(valid)
  assert.equal(validateProjection(valid), true)
  assert.throws(() => adapted.validate({ nested: 'no' }), /original App schema/)
})
