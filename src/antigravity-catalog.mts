import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { acpRecord } from './acp-process.mjs'
import type { ClaudeEffort } from './claude-models.mjs'
import { resolveRuntimeConfig } from './runtime-config.mjs'
import { adapterHome } from './util.mjs'

// ACP model variants are not ordered by reasoning intensity. The App renders
// the supplied order directly as slider positions, so normalize both fresh
// reports and previously persisted catalogs.
function orderedEfforts(values: readonly unknown[]): ClaudeEffort[] {
  const order: ClaudeEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
  return order.filter((value) => values.includes(value))
}

export interface AntigravityModelOption {
  id: string
  sdkModel: string
  displayName: string
  description: string
  isDefault: boolean
  efforts: readonly ClaudeEffort[]
}

export function useAntigravityRuntime(): boolean {
  return resolveRuntimeConfig().type === 'antigravity-acp'
}

export function acpConfigOptions(session: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(session.configOptions) ? session.configOptions.map(acpRecord) : []
}

export function acpSelectOptions(config: Record<string, unknown>): Record<string, unknown>[] {
  const options = Array.isArray(config.options) ? config.options.map(acpRecord) : []
  return options.flatMap((option) =>
    Array.isArray(option.options) ? acpSelectOptions(option) : [option],
  )
}

export function noteAntigravityModels(session: Record<string, unknown>): void {
  const configs = acpConfigOptions(session)
  const config = configs.find((option) => option.category === 'model' || option.id === 'model')
  const models = acpRecord(session.models)
  const available = config
    ? acpSelectOptions(config)
    : Array.isArray(models.availableModels)
      ? models.availableModels.map(acpRecord)
      : []
  const current = config?.currentValue ?? models.currentModelId
  const effort = configs.find((option) =>
    /thought|think|reason|effort/i.test(`${option.category} ${option.id} ${option.name}`),
  )
  const efforts: ClaudeEffort[] = effort
    ? acpSelectOptions(effort).flatMap((option) => {
        const value = String(option.value ?? option.name ?? '').toLowerCase()
        const mapped = value === 'extra' ? 'xhigh' : value
        return ['low', 'medium', 'high', 'xhigh', 'max'].includes(mapped)
          ? [mapped as ClaudeEffort]
          : []
      })
    : []
  const catalog: AntigravityModelOption[] = available.flatMap((option) => {
    const id = String(option.value ?? option.modelId ?? '')
    return id
      ? [
          {
            id: `antigravity/${id}`,
            sdkModel: id,
            displayName: `Antigravity · ${option.name ?? id}`,
            description: String(option.description ?? 'Antigravity CLI via ACP'),
            isDefault: id === current,
            efforts: (() => {
              const variants = Array.isArray(models.availableModels)
                ? models.availableModels.map(acpRecord)
                : []
              const supported = variants.flatMap((entry) => {
                const modelId = String(entry.modelId ?? '')
                const suffix = modelId.startsWith(`${id}-`) ? modelId.slice(id.length + 1) : ''
                return ['low', 'medium', 'high', 'xhigh', 'max'].includes(suffix)
                  ? [suffix as ClaudeEffort]
                  : []
              })
              if (supported.length) return orderedEfforts(supported)
              const prior = antigravityModelOptions().find((entry) => entry.sdkModel === id)
              return orderedEfforts(id === current ? efforts : (prior?.efforts ?? []))
            })(),
          },
        ]
      : []
  })
  if (!catalog.length) return
  mkdirSync(adapterHome(), { recursive: true })
  // Replace rather than merge: removed or account-restricted models must vanish.
  writeFileSync(
    join(adapterHome(), 'antigravity-models.json'),
    `${JSON.stringify(catalog, null, 2)}\n`,
  )
}

export function antigravityModelOptions(): AntigravityModelOption[] {
  try {
    const models: unknown = JSON.parse(
      readFileSync(join(adapterHome(), 'antigravity-models.json'), 'utf8'),
    )
    if (
      Array.isArray(models) &&
      models.length &&
      models.every((model) => typeof model.id === 'string' && Array.isArray(model.efforts))
    )
      return (models as AntigravityModelOption[]).map((model) => ({
        ...model,
        efforts: orderedEfforts(model.efforts),
      }))
  } catch {}
  return [
    {
      id: 'default',
      sdkModel: 'default',
      displayName: 'Antigravity · Default model',
      description:
        'The model selected in Antigravity CLI. Connect once to discover available models.',
      isDefault: true,
      efforts: [],
    },
  ]
}
