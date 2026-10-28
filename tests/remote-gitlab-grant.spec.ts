import { describe, expect, it } from 'vitest'
import type { CredentialRecord } from '../src/remote/credentials-types.ts'
import type { GitRemoteCredentialService } from '../src/remote/credentials.ts'
import { gitLabGrantKey } from '../src/remote/instances.ts'
import { parseGitLabGrant, retireGitLabGrant } from '../src/remote/gitlab-grant.ts'

const instance = 'https://git.example.com'
function store() {
  const records = new Map<string, CredentialRecord>()
  const service: GitRemoteCredentialService = {
    readRecord: async key => records.get(key),
    modifyRecord: async (key, mutate) => { const next = await mutate(records.get(key)); if (next !== undefined) records.set(key, next); return records.get(key) },
    deleteRecord: async key => { records.delete(key) },
    resolve: async () => { throw Error('must not resolve') },
    describe: async () => { throw Error('must not describe') },
    describeRecord: async () => { throw Error('must not describe') },
  }
  return { records, service }
}
const grant = (extra: Record<string, unknown> = {}): CredentialRecord => ({ kind: 'grant', payload: { v: 2, provider: 'gitlab', instance, revision: 'old', state: 'authenticated', clientId: 'app', accessToken: 'secret', refreshToken: 'refresh', expiresAt: 100, ...extra } })
describe('GitLab v2 grant retirement', () => {
  it('normalizes, atomically replaces secrets, preserves sibling records and is idempotent', async () => {
    const s = store(), key = gitLabGrantKey(instance), other = gitLabGrantKey('https://other.example')
    s.records.set(key, grant()); s.records.set(other, grant())
    expect(await retireGitLabGrant(s.service, 'https://GIT.EXAMPLE.COM:443/', () => 'new')).toEqual({ instance, disposition: 'retired' })
    expect(s.records.get(key)).toEqual({ kind: 'grant', payload: { v: 2, provider: 'gitlab', instance, revision: 'new', state: 'signed-out', retired: true } })
    expect(s.records.get(other)).toEqual(grant())
    expect((await retireGitLabGrant(s.service, instance)).disposition).toBe('already-retired')
    expect((await retireGitLabGrant(s.service, 'https://absent.example')).disposition).toBe('absent')
  })
  it.each([{ provider: 'github' }, { instance: 'https://other.example' }, { v: 1 }, { expiresAt: undefined }, { state: 'refreshing' }])('rejects mismatched or malformed records without mutation', async extra => {
    const s = store(), key = gitLabGrantKey(instance), before = grant(extra)
    s.records.set(key, before)
    await expect(retireGitLabGrant(s.service, instance)).rejects.toMatchObject({ details: { reason: 'record-mismatch' } })
    expect(s.records.get(key)).toBe(before)
  })
  it('does not report success when storage fails', async () => {
    const s = store(); s.records.set(gitLabGrantKey(instance), grant())
    s.service.modifyRecord = async () => { throw Error('store failure') }
    await expect(retireGitLabGrant(s.service, instance)).rejects.toThrow('store failure')
  })
  it('accepts valid refreshing records for replacement and protects malformed suppression markers', () => {
    expect(parseGitLabGrant(grant({ state: 'refreshing', refreshId: 'r', basedOnRevision: 'old', refreshExpiresAt: 100 }), instance)?.state).toBe('refreshing')
    expect(parseGitLabGrant(grant({ state: 'signed-out', retired: true }), instance)).toBeUndefined()
  })
})
