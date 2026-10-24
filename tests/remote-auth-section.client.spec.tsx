// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { RemoteAuthSection } from '../src/client/remote/RemoteAuthSection.tsx'
import type { GitRemoteCapabilityOn } from '../src/remote/types.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)
const capability: GitRemoteCapabilityOn = {
  state: 'on', generation: { instanceId: 'test', revision: 1 },
  credential: { configured: true, writable: true }, auth: { state: 'authenticated' },
  actions: { canComment: 'unknown', canReview: 'unknown', canMerge: 'unknown', canClose: 'unknown', canCreatePr: 'unknown' },
  loginAvailable: true, automaticRefreshAvailable: false,
}
describe('authentication source', () => {
  it.each([
    [{ state: 'authenticated', source: 'gh' }, 'remote.authSourceGh'],
    [{ state: 'authenticated', source: 'grant' }, 'remote.authSourceOAuth'],
    [{ state: 'authenticated', source: 'ref' }, 'remote.authSourceRef'],
    [{ state: 'authenticated', source: 'git-credential' }, 'remote.authSourceGitCredential'],
    [{ state: 'authenticated' }, 'remote.authSourceUnknown'],
    [{ state: 'authenticated', source: 'future-provider' }, 'remote.authSourceUnknown'],
    [{ state: 'anonymous' }, 'remote.authSourceAnonymous'],
    [{ state: 'signed-out', source: 'gh' }, 'remote.authSourceNone'],
    [{ state: 'invalid', source: 'grant' }, 'remote.authSourceNone'],
  ] as const)('localizes %j without exposing raw provider metadata', (auth, label) => {
    for (const messages of [en, zh]) {
      const view = render(<RemoteAuthSection capability={{ ...capability, auth: auth as GitRemoteCapabilityOn['auth'] }}
        viewer={undefined} busy={false} login={undefined} onAuth={vi.fn()} onLogin={vi.fn()} onCancelLogin={vi.fn()}
        t={key => messages[key]} />)
      expect(screen.getByText(messages['remote.authChannel'])).not.toBeNull()
      expect(screen.getByText(messages[label], { exact: true })).not.toBeNull()
      expect(view.container.textContent).not.toContain('future-provider')
      view.unmount()
    }
  })
})
