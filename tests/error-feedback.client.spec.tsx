// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describeRemoteError, describeLocalError, ErrorToast, useErrorToast } from '../src/client/error-feedback.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
const t = (key: Parameters<typeof describeRemoteError>[3] extends (k: infer K) => string ? K : never) => en[key]

describe('describeRemoteError', () => {
  it.each([
    ['git/unauthenticated', undefined, 'github', 'Your GitHub sign-in has expired. Reconnect to continue'],
    ['git/signed-out', undefined, 'gitlab', "You're disconnected from GitLab. Connect to continue"],
    ['git/insufficient-scope', { reason: 'sso-required' }, 'gitlab', 'Complete SSO authorization on GitLab first'],
    ['git/insufficient-scope', undefined, 'github', "Your account doesn't have permission for this action"],
    ['git/rate-limited', undefined, 'gitlab', 'GitLab is rate limiting requests. Try again later'],
    ['git/head-moved', undefined, 'github', 'The content changed. Refresh and try again'],
    ['git/remote-identity-mismatch', undefined, 'github', 'The account or repository changed. Refresh and try again'],
    ['git/write-result-unknown', undefined, 'gitlab', "Couldn't confirm whether the action succeeded. Refresh and check before trying again"],
    ['stale-confirmation', undefined, 'github', 'The confirmation expired. Confirm again'],
    ['Git checkout needs attention', undefined, 'github', "Local checkout didn't finish. Check the branch and working tree"],
    ['git/remote-unavailable', { reason: 'instance-removed' }, 'gitlab', 'This GitLab instance is no longer available'],
    ['git/remote-unavailable', { reason: 'not-supported' }, 'gitlab', "GitLab doesn't support this action"],
    ['git/remote-unavailable', { reason: 'invalid-request' }, 'gitlab', "Couldn't reach GitLab. Try again later"],
    ['ECONNRESET', undefined, undefined, `Couldn't reach ${en['remote.platform']}. Try again later`],
  ] as const)('maps %s to its summary', (code, details, provider, summary) => {
    const report = describeRemoteError(code, details, provider, t)
    expect(report.summary).toBe(summary)
    expect(report.detail.startsWith(`code: ${code}`)).toBe(true)
  })
  it('joins allowlisted detail fields onto their own lines', () => {
    const report = describeRemoteError('git/unauthenticated', { reason: 'stale-generation', number: 7 }, 'gitlab', t)
    expect(report.detail).toBe('code: git/unauthenticated\nreason: stale-generation\nnumber: 7')
  })
  it('produces a local report with the raw message only in the detail', () => {
    const report = describeLocalError('error.local.loadDiff', 'status exploded', t)
    expect(report).toEqual({ summary: en['error.local.loadDiff'], detail: 'status exploded' })
  })
})

describe('ErrorToast', () => {
  it('shows the summary and copies the detail through the action', async () => {
    const copy = vi.fn(async (_text: string) => {})
    render(<ErrorToast report={{ summary: 'Something failed', detail: 'code: x' }} onDone={() => {}} copy={copy} t={t} />)
    expect(screen.getByRole('alert').textContent).toContain('Something failed')
    fireEvent.click(screen.getByRole('button', { name: en['error.copyDetails'] }))
    await waitFor(() => expect(copy).toHaveBeenCalledWith('code: x'))
    expect(await screen.findByText(en['error.copyDone'])).toBeTruthy()
  })
  it('reports a copy failure instead of copying', async () => {
    const copy = vi.fn(async () => { throw new Error('denied') })
    render(<ErrorToast report={{ summary: 'Something failed', detail: 'code: x' }} onDone={() => {}} copy={copy} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: en['error.copyDetails'] }))
    expect(await screen.findByText(en['error.copyFailed'])).toBeTruthy()
  })
})

function Probe({ value }: { readonly value: string | undefined }) {
  const toast = useErrorToast(value)
  return <span data-testid="probe">{toast.active ? `shown:${toast.seq}` : 'hidden'}</span>
}

describe('useErrorToast', () => {
  it('re-shows when the same error returns after clearing', () => {
    const view = render(<Probe value={undefined} />)
    expect(screen.getByTestId('probe').textContent).toBe('hidden')
    view.rerender(<Probe value="failed" />)
    expect(screen.getByTestId('probe').textContent).toBe('shown:1')
    view.rerender(<Probe value={undefined} />)
    expect(screen.getByTestId('probe').textContent).toBe('hidden')
    view.rerender(<Probe value="failed" />)
    expect(screen.getByTestId('probe').textContent).toBe('shown:2')
  })
})

function ToastHarness({ value }: { readonly value: string | undefined }) {
  const toast = useErrorToast(value)
  return toast.active && value !== undefined
    ? <ErrorToast key={toast.seq} report={{ summary: value, detail: value }} onDone={toast.dismiss} t={t} />
    : null
}

describe('useErrorToast dismissal', () => {
  it('stays dismissed while the same error persists, then re-shows after a clear', () => {
    vi.useFakeTimers()
    try {
      const view = render(<ToastHarness value="failed" />)
      expect(screen.getByRole('alert').textContent).toContain('failed')
      act(() => { vi.advanceTimersByTime(7000) })
      expect(screen.queryByRole('alert')).toBeNull()
      // The persisting error must not raise a fresh toast once the hold elapsed.
      act(() => { vi.advanceTimersByTime(20000) })
      expect(screen.queryByRole('alert')).toBeNull()
      view.rerender(<ToastHarness value={undefined} />)
      view.rerender(<ToastHarness value="failed" />)
      expect(screen.getByRole('alert').textContent).toContain('failed')
    } finally {
      vi.useRealTimers()
    }
  })
})
