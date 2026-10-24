import { describe, expect, it, vi } from 'vitest'
import {
  GIT_REMOTE_CREDENTIAL_MEMBERS,
  gitRemoteCredentialKey,
  gitRemoteCredentialRef,
  probeCredentialsService,
} from '../src/remote/credentials.ts'
import { GitRemoteUnavailableError, remoteCapability } from '../src/remote/feature.ts'

const SECRET = 'gho_SENTINEL-TOKEN-n3v3r-w1r3'

function completeProvider() {
  return {
    accessToken: SECRET,
    records: { 'dsh-plugin-git/github-com': { kind: 'grant', payload: { accessToken: SECRET } } },
    readRecord: vi.fn(async () => ({ kind: 'grant', payload: { accessToken: SECRET } })),
    modifyRecord: vi.fn(async () => undefined),
    deleteRecord: vi.fn(async () => undefined),
    resolve: vi.fn(async () => ({ value: SECRET, source: 'store' })),
    describe: vi.fn(async () => ({ configured: true, writable: true, source: 'store' })),
    describeRecord: vi.fn(async () => ({ configured: true, kind: 'grant', writable: true })),
    notifyRecordUpdated: vi.fn(),
  }
}

describe('remote credential key/ref grammar', () => {
  it('brands a valid scope/id pair as the joined key', () => {
    expect(gitRemoteCredentialKey('dsh-plugin-git', 'github-com')).toBe('dsh-plugin-git/github-com')
  })

  it.each([
    ['GitHub', 'com'],
    ['-lead-dash', 'com'],
    ['under_score', 'com'],
    ['', 'com'],
    ['dsh-plugin-git', 'GitHub-com'],
    ['dsh-plugin-git', 'slash/in'],
    ['dsh-plugin-git', ''],
  ])('rejects out-of-grammar key segment pair %j', (scope, id) => {
    expect(() => gitRemoteCredentialKey(scope, id)).toThrow(TypeError)
  })

  it('brands a valid POSIX identifier as a ref', () => {
    expect(gitRemoteCredentialRef('GH_TOKEN')).toBe('GH_TOKEN')
    expect(gitRemoteCredentialRef('_private_1')).toBe('_private_1')
  })

  it.each(['9LIVES', 'A-B', 'a b', '', 'TOKEN/NAME'])('rejects out-of-grammar ref %j', (value) => {
    expect(() => gitRemoteCredentialRef(value)).toThrow(TypeError)
  })
})

describe('credentials seam structural probe', () => {
  it.each([undefined, null])('reports missing for %s', (value) => {
    expect(probeCredentialsService(value)).toEqual({ state: 'missing' })
  })

  it.each(['credentials', 42, true])('reports every member missing for primitive %j', (value) => {
    expect(probeCredentialsService(value)).toEqual({
      state: 'incomplete',
      missing: [...GIT_REMOTE_CREDENTIAL_MEMBERS],
    })
  })

  it.each(GIT_REMOTE_CREDENTIAL_MEMBERS)('denies a provider lacking %s', (member) => {
    const provider = completeProvider() as Record<string, unknown>
    delete provider[member]
    expect(probeCredentialsService(provider)).toEqual({ state: 'incomplete', missing: [member] })
  })

  it.each(GIT_REMOTE_CREDENTIAL_MEMBERS)('denies a provider whose %s is not callable', (member) => {
    const provider = { ...completeProvider(), [member]: 'not-a-function' }
    expect(probeCredentialsService(provider)).toEqual({ state: 'incomplete', missing: [member] })
  })

  it('rejects a provider exposing only a generic event API', () => {
    const provider = { on: () => {}, once: () => {}, emit: () => {}, off: () => {} }
    expect(probeCredentialsService(provider)).toEqual({
      state: 'incomplete',
      missing: [...GIT_REMOTE_CREDENTIAL_MEMBERS],
    })
  })

  it('accepts members inherited from a prototype, including the notifier', () => {
    const provider = Object.create(completeProvider())
    expect(probeCredentialsService(provider)).toEqual({ state: 'supported' })
    class PrototypeProvider {
      readRecord() {}
      modifyRecord() {}
      deleteRecord() {}
      resolve() {}
      describe() {}
      describeRecord() {}
      notifyRecordUpdated() {}
    }
    expect(probeCredentialsService(new PrototypeProvider())).toEqual({ state: 'supported' })
  })

  it('treats a throwing member getter as a missing member', () => {
    const provider = {
      ...completeProvider(),
      get notifyRecordUpdated(): never {
        throw new Error(SECRET)
      },
    }
    expect(probeCredentialsService(provider)).toEqual({ state: 'incomplete', missing: ['notifyRecordUpdated'] })
  })

  it('never invokes provider members while probing', () => {
    const provider = completeProvider()
    probeCredentialsService(provider)
    remoteCapability(provider)
    for (const member of GIT_REMOTE_CREDENTIAL_MEMBERS) {
      expect(provider[member]).not.toHaveBeenCalled()
    }
  })
})

describe('remoteCapability', () => {
  it('reports credentials-missing with no member list when no seam exists', () => {
    expect(remoteCapability(undefined)).toEqual({
      state: 'off',
      reason: 'credentials-missing',
      auth: { state: 'off' },
    })
  })

  it('reports credentials-incomplete with allowlisted missing names', () => {
    const provider = completeProvider() as Record<string, unknown>
    delete provider['deleteRecord']
    delete provider['resolve']
    expect(remoteCapability(provider)).toEqual({
      state: 'off',
      reason: 'credentials-incomplete',
      missing: ['deleteRecord', 'resolve'],
      auth: { state: 'off' },
    })
  })

  it('reports implementation-pending for a complete seam until the runtime lands', () => {
    expect(remoteCapability(completeProvider())).toEqual({
      state: 'off',
      reason: 'implementation-pending',
      auth: { state: 'off' },
    })
  })

  it('invents no storage or identity facts in the off answer', () => {
    for (const value of [undefined, {}, completeProvider()]) {
      const capability = remoteCapability(value)
      expect(capability).not.toHaveProperty('credential')
      expect(capability).not.toHaveProperty('generation')
      expect(capability).not.toHaveProperty('viewer')
      expect(capability).not.toHaveProperty('permissions')
      expect(capability).not.toHaveProperty('actions')
    }
  })

  it('carries no secret or provider field onto the wire answer', () => {
    for (const capability of [remoteCapability(completeProvider()), remoteCapability({})]) {
      expect(JSON.stringify(capability)).not.toContain('SENTINEL')
      expect(JSON.stringify(capability)).not.toContain('accessToken')
    }
  })
})

describe('GitRemoteUnavailableError', () => {
  it('carries the fixed code, a safe message, and only structured details', () => {
    const error = new GitRemoteUnavailableError(remoteCapability(completeProvider()))
    expect(error.code).toBe('git/remote-unavailable')
    expect(error.name).toBe('GitRemoteUnavailableError')
    expect(error.details).toEqual({ reason: 'implementation-pending' })
    expect(JSON.stringify(error.details)).not.toContain('SENTINEL')
  })

  it('propagates the incomplete reason and missing member names', () => {
    const error = new GitRemoteUnavailableError(remoteCapability({}))
    expect(error.details).toEqual({
      reason: 'credentials-incomplete',
      missing: [...GIT_REMOTE_CREDENTIAL_MEMBERS],
    })
  })
})
