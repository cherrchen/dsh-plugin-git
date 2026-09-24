import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'

const require = createRequire(import.meta.url)

describe('host entry on the installed DSH runtime', () => {
  it('evaluates Config, marking fields volatile only when schemastery provides the method', () => {
    const schemastery = require('@deepseek-ai/schemastery') as {
      string: () => { volatile?: () => unknown }
    }
    const hasVolatile = typeof schemastery.string().volatile === 'function'
    const fields = (Config as unknown as {
      dict: { commitMessage: { dict: Record<string, { meta?: { volatile?: boolean } }> } }
    }).dict.commitMessage.dict
    for (const name of ['mode', 'provider', 'model', 'systemPrompt', 'maxDiffBytes']) {
      expect(fields[name]?.meta?.volatile === true).toBe(hasVolatile)
    }
  })
})
