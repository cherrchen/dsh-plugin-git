import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CREDENTIALS_SEAM_DSH_RELEASES, SUPPORTED_DSH_RELEASES } from '../src/compat/dsh-version.ts'
import { describe, expect, it } from 'vitest'
import { gitRemoteCredentialKey, gitRemoteCredentialRef } from '../src/remote/credentials.ts'
const specifier = '@deepseek-ai/dsh-credentials'
let upstream: { credentialKey(scope: string, id: string): string; credentialRef(value: string): string } | undefined
const lane = process.env['DSH_COMPAT_VERSION']
const supportedSeamLane = lane === undefined || !(SUPPORTED_DSH_RELEASES as readonly string[]).includes(lane) || (CREDENTIALS_SEAM_DSH_RELEASES as readonly string[]).includes(lane)
if (!supportedSeamLane && existsSync(join(process.cwd(), 'node_modules/@deepseek-ai/dsh-credentials'))) throw new Error('Old lane unexpectedly installed the optional credentials package')
let entry: string | undefined
try { if (supportedSeamLane) entry = createRequire(import.meta.url).resolve(specifier) } catch (error) {
  if ((error as { code?: string }).code !== 'MODULE_NOT_FOUND') throw error
}
if (entry !== undefined) upstream = await import(/* @vite-ignore */ pathToFileURL(entry).href)

describe('local optional credential contract', () => {
  it.skipIf(upstream === undefined)('matches published key/ref constructors without a runtime production import', () => {
    expect(gitRemoteCredentialKey('dsh-plugin-git', 'github-com')).toBe(upstream!.credentialKey('dsh-plugin-git', 'github-com'))
    expect(gitRemoteCredentialRef('GH_TOKEN')).toBe(upstream!.credentialRef('GH_TOKEN'))
    for (const value of ['bad/key', '-bad', 'UPPER', 'has space']) {
      expect(() => gitRemoteCredentialKey(value, 'github-com')).toThrow()
      expect(() => upstream!.credentialKey(value, 'github-com')).toThrow()
    }
    for (const value of ['bad-ref', '1TOKEN', 'has space']) {
      expect(() => gitRemoteCredentialRef(value)).toThrow()
      expect(() => upstream!.credentialRef(value)).toThrow()
    }
  })
})
