import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'
import { readVolatile } from '../src/compat/dsh-schema.ts'
import { resolveRemoteSettings } from '../src/remote/settings.ts'

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
    const worktreeFields = (Config as unknown as {
      dict: { worktrees: { dict: Record<string, { meta?: { volatile?: boolean } }> } }
    }).dict.worktrees.dict
    for (const name of ['enabled', 'directory']) {
      expect(worktreeFields[name]?.meta?.volatile === true).toBe(hasVolatile)
    }
  })
})


it('parses the optional instance array through the installed schema without changing GitHub clientId', () => {
  const parse = Config as unknown as (input: unknown) => { remote: { clientId?: string; instances?: unknown } }
  const parsed = parse({ remote: { clientId: 'github-app', instances: [{ url: 'https://git.example.com/gitlab', clientId: 'gitlab-app', sshPort: 2222 }] } })
  const instances = readVolatile(parsed.remote.instances)
  expect(Array.isArray(instances)).toBe(true)
  const resolved = resolveRemoteSettings(parsed.remote as Parameters<typeof resolveRemoteSettings>[0])
  expect(resolved.clientId).toBe('github-app')
  expect(resolved.instances[0]).toMatchObject({ instance: 'https://git.example.com/gitlab', clientId: 'gitlab-app', sshPort: 2222 })
})
