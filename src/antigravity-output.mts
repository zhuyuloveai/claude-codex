import { Ajv } from 'ajv'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { acpRecord } from './acp-process.mjs'

// ACP has no constrained decoding parameter. Validate before publishing the
// final text instead of returning malformed JSON as a successful result.
export function antigravityOutputValidator(format: unknown): ((text: string) => void) | null {
  if (format == null) return null
  const value = acpRecord(format)
  const schema = value.type === 'json_schema' ? value.schema : format
  const options = { strict: false, allErrors: true, validateFormats: false }
  const ajv = String(acpRecord(schema).$schema ?? '').includes('2020-12')
    ? new Ajv2020(options)
    : new Ajv(options)
  const validate = ajv.compile(schema as object | boolean)
  return (text) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error('Antigravity returned invalid JSON for the requested output schema')
    }
    if (!validate(parsed))
      throw new Error(
        `Antigravity output does not match the requested schema: ${ajv.errorsText(validate.errors)}`,
      )
  }
}
