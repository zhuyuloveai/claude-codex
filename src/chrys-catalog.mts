import { execFileSync } from 'node:child_process'

export interface ChrysModelOption {
  id: string
  sdkModel: string
  displayName: string
  description: string
  isDefault: boolean
  inputModalities: string[]
}

let cache: { expiresAt: number; models: ChrysModelOption[] } | null = null

export function chrysModelOptions(): ChrysModelOption[] {
  if (cache && cache.expiresAt > Date.now()) return cache.models
  const command = process.env.CHRYS_CODEX_EXECUTABLE ?? 'chrys'
  try {
    const parsed = JSON.parse(
      execFileSync(command, ['models', '--json'], { encoding: 'utf8', timeout: 10_000 }),
    ) as {
      models?: Array<Record<string, unknown>>
      active?: string
    }
    const models = (parsed.models ?? [])
      .map((model) => {
        const id = String(model.id ?? model.modelId ?? model.name ?? '')
        const displayName = String(model.name ?? model.modelId ?? id)
        const provider = String(model.provider ?? 'configured provider')
        const context = Number(model.maxContextTokens)
        return {
          id,
          sdkModel: id,
          displayName: `Chrys · ${displayName}`,
          description: `Chrys model profile via ${provider}${Number.isFinite(context) ? ` · ${context} context tokens` : ''}`,
          isDefault: model.active === true || parsed.active === id,
          inputModalities: model.vision === true ? ['text', 'image'] : ['text'],
        }
      })
      .filter((model) => model.id.length > 0)
    if (models.length > 0) {
      cache = { expiresAt: Date.now() + 15_000, models }
      return models
    }
  } catch {}
  return [
    {
      id: 'default',
      sdkModel: 'default',
      displayName: 'Chrys · Active model',
      description: 'The model profile currently active in Chrys.',
      isDefault: true,
      inputModalities: ['text'],
    },
  ]
}

export function useChrysRuntime(): boolean {
  if (process.env.CLAUDE_CODEX_MOCK === '1') return false
  const explicit = process.env.CHRYS_CODEX_RUNTIME_TYPE ?? process.env.CLAUDE_CODEX_RUNTIME_TYPE
  return !explicit || ['chrys', 'chrys-acp', 'acp'].includes(explicit.trim().toLowerCase())
}
