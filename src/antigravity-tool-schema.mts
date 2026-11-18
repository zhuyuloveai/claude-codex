import { Ajv } from 'ajv'
import { Ajv2020 } from 'ajv/dist/2020.js'

// Antigravity validates regexes with Go/RE2, while App JSON Schema uses
// ECMAScript (including lookahead). Advertise a regex-free projection and
// enforce the original schema in JavaScript before dispatching any call.
export function antigravityToolSchema(original: Record<string, unknown>) {
  const options = { strict: false, validateFormats: false, allErrors: true }
  const ajv = String(original.$schema ?? '').includes('draft-07')
    ? new Ajv(options)
    : new Ajv2020(options)
  const validate = ajv.compile(original)
  const hasRegex = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false
    return Object.entries(value).some(
      ([key, entry]) => key === 'pattern' || key === 'patternProperties' || hasRegex(entry),
    )
  }
  const project = (value: unknown): unknown => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    const schema = value as Record<string, unknown>
    const next = { ...schema }
    if (typeof next.pattern === 'string') {
      next.description = [
        next.description,
        `Value must satisfy this ECMAScript regular expression (validated by the bridge): ${next.pattern}`,
      ]
        .filter(Boolean)
        .join('\n')
      delete next.pattern
    }
    if ('patternProperties' in next) {
      delete next.patternProperties
      next.additionalProperties = true
      delete next.unevaluatedProperties
    }
    // Removing a predicate inside negation or a conditional could narrow
    // instead of widen the advertised schema. Leave these to local validation.
    if (hasRegex(schema.not)) delete next.not
    if (hasRegex(schema.if)) {
      delete next.if
      delete next.then
      delete next.else
    }
    for (const key of ['properties', '$defs', 'definitions', 'dependentSchemas']) {
      const entries = next[key]
      if (entries && typeof entries === 'object' && !Array.isArray(entries))
        next[key] = Object.fromEntries(
          Object.entries(entries).map(([name, item]) => [name, project(item)]),
        )
    }
    for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
      if (Array.isArray(next[key])) next[key] = next[key].map(project)
    }
    if (hasRegex(schema.contains)) delete next.maxContains
    // oneOf can become ambiguous after weakening its branches.
    if (hasRegex(schema.oneOf)) {
      next.anyOf = next.oneOf
      delete next.oneOf
    }
    for (const key of [
      'items',
      'additionalProperties',
      'unevaluatedProperties',
      'unevaluatedItems',
      'contains',
      'propertyNames',
      'not',
      'if',
      'then',
      'else',
    ])
      if (key in next) next[key] = project(next[key])
    return next
  }
  return {
    schema: project(original) as Record<string, unknown>,
    validate(args: unknown) {
      if (!validate(args))
        throw new Error(
          `Tool arguments do not match the original App schema: ${ajv.errorsText(validate.errors)}`,
        )
    },
  }
}
