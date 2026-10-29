// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RemoteAuthControl } from '../src/client/remote/RemoteAuthControl.tsx'
import type { GitRemoteController } from '../src/client/remote.ts'
import type { GitRemoteCapabilityOn } from '../src/remote/types.ts'
import { en } from '../src/client/locales.ts'
afterEach(cleanup)
const capability: GitRemoteCapabilityOn = { state: 'on', generation: { instanceId: 'opaque', revision: 0 }, credential: { configured: false, writable: true }, auth: { state: 'unauthenticated' }, actions: { canComment: 'unknown', canReview: 'unknown', canMerge: 'unknown', canClose: 'unknown', canCreatePr: 'unknown' }, loginAvailable: false, automaticRefreshAvailable: false }
describe('orphan-grant confirmation', () => {
  it('requires a separate confirmation and displays the normalized scope and result', async () => {
    const retireGrant = vi.fn(async () => ({ disposition: 'retired' as const }))
    const snapshot = { pending: undefined, error: undefined }
    const controller = { scopedAvailable: true, retireGrant, getSnapshot: () => snapshot, subscribe: () => () => {}, authAction: vi.fn(), login: vi.fn(), cancelLogin: vi.fn() } as unknown as GitRemoteController
    render(<RemoteAuthControl capability={capability} viewer={undefined} busy={false} controller={controller} t={key => en[key]} />)
    fireEvent.click(screen.getByRole('button', { name: en['remote.auth'] }))
    expect(document.querySelector('details')?.open).toBe(false)
    fireEvent.click(screen.getByText(en['remote.advanced'], { exact: true }))
    fireEvent.change(screen.getByLabelText(en['remote.retireUrl']), { target: { value: 'https://GIT.EXAMPLE.COM:443/' } })
    fireEvent.click(screen.getByRole('button', { name: en['remote.retirePrepare'] }))
    expect(retireGrant).not.toHaveBeenCalled(); expect(screen.getByText('https://git.example.com')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['remote.retireConfirm'] }))
    await waitFor(() => expect(retireGrant).toHaveBeenCalledWith('https://git.example.com'))
    expect(await screen.findByText(en['remote.retireDone'])).toBeTruthy()
  })
})
