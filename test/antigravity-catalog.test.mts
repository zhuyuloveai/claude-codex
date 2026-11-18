import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { antigravityModelOptions, noteAntigravityModels } from '../src/antigravity-catalog.mjs'

test('ACP model variants and old caches become ascending App slider positions', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agy-catalog-test-'))
  const old = process.env.CLAUDE_CODEX_HOME
  const oldChrys = process.env.CHRYS_CODEX_HOME
  process.env.CLAUDE_CODEX_HOME = home
  delete process.env.CHRYS_CODEX_HOME
  try {
    noteAntigravityModels({
      configOptions: [
        {
          id: 'model',
          category: 'model',
          currentValue: 'carbon',
          options: [
            { value: 'carbon', name: 'Carbon' },
            { value: 'hydrogen', name: 'Hydrogen' },
          ],
        },
      ],
      models: {
        availableModels: [
          'carbon-medium',
          'carbon-high',
          'carbon-low',
          'hydrogen-high',
          'hydrogen-xhigh',
          'hydrogen-medium',
          'hydrogen-low',
        ].map((modelId) => ({ modelId })),
      },
    })
    const fresh = antigravityModelOptions()
    assert.deepEqual(fresh[0]?.efforts, ['low', 'medium', 'high'])
    assert.deepEqual(fresh[1]?.efforts, ['low', 'medium', 'high', 'xhigh'])
    await writeFile(
      join(home, 'antigravity-models.json'),
      JSON.stringify([{ ...fresh[0], efforts: ['medium', 'high', 'low', 'high', 'unknown'] }]),
    )
    assert.deepEqual(antigravityModelOptions()[0]?.efforts, ['low', 'medium', 'high'])
    noteAntigravityModels({
      configOptions: [
        { id: 'model', category: 'model', currentValue: 'carbon', options: [{ value: 'carbon' }] },
        {
          id: 'thought_level',
          category: 'thought_level',
          options: [{ value: 'high' }, { value: 'low' }, { value: 'medium' }],
        },
      ],
    })
    assert.deepEqual(antigravityModelOptions()[0]?.efforts, ['low', 'medium', 'high'])
  } finally {
    if (old === undefined) delete process.env.CLAUDE_CODEX_HOME
    else process.env.CLAUDE_CODEX_HOME = old
    if (oldChrys === undefined) delete process.env.CHRYS_CODEX_HOME
    else process.env.CHRYS_CODEX_HOME = oldChrys
    await rm(home, { recursive: true, force: true })
  }
})
