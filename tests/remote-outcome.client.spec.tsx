// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RemoteBlockedToast } from '../src/client/remote/RemoteOutcome.tsx'
import { en } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function fixture() {
  return {
    outcome: undefined,
    action: 'remote-review',
    error: 'git/write-result-unknown',
    errorDetails: { action: 'remote-review', number: 7 },
    provider: 'gitlab' as const,
    reconciled: false,
    seq: 1,
    onAcknowledge: vi.fn(),
    t: (key: keyof typeof en) => en[key],
  }
}

describe('blocked write copy feedback', () => {
  it.each([
    ['missing clipboard', undefined],
    ['missing writer', {}],
    ['throwing writer', { writeText: () => { throw new Error('unavailable') } }],
    ['rejected write', { writeText: async () => { throw new Error('denied') } }],
  ])('keeps reconciliation available after %s and permits another copy attempt', async (_label, clipboard) => {
    vi.stubGlobal('navigator', { clipboard })
    const props = fixture()
    const view = render(<RemoteBlockedToast {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en['error.copyDetails'] }))
    expect(await screen.findByText(new RegExp(en['error.copyFailed']))).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain(en['gitlab.reconcileHint'])
    expect(screen.queryByRole('button', { name: en['gitlab.reconcile'] })).toBeNull()
    expect(props.onAcknowledge).not.toHaveBeenCalled()

    // A clipboard retry must neither dismiss the warning nor acknowledge the write.
    const writeText = vi.fn(async (_text: string) => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    fireEvent.click(screen.getByRole('button', { name: en['error.copyDetails'] }))
    expect(await screen.findByText(new RegExp(en['error.copyDone']))).toBeTruthy()
    expect(screen.getByRole('alert').textContent).not.toContain(en['error.copyFailed'])
    expect(writeText).toHaveBeenCalledWith('code: git/write-result-unknown\naction: remote-review\nnumber: 7')
    expect(props.onAcknowledge).not.toHaveBeenCalled()

    view.rerender(<RemoteBlockedToast {...props} reconciled />)
    fireEvent.click(screen.getByRole('button', { name: en['gitlab.reconcile'] }))
    expect(props.onAcknowledge).toHaveBeenCalledOnce()
  })
  it('copies receipt diagnostics and drops copy feedback when the error changes', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const props = fixture()
    const view = render(<RemoteBlockedToast {...props} outcome={{ outcome: 'partial', steps: [], receipt: { error: 'merge-method-mismatch' } }} />)
    fireEvent.click(screen.getByRole('button', { name: en['error.copyDetails'] }))
    expect(await screen.findByText(new RegExp(en['error.copyDone']))).toBeTruthy()
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('\nreceipt: merge-method-mismatch'))
    view.rerender(<RemoteBlockedToast {...props} error="git/head-moved" />)
    expect(screen.getByRole('alert').textContent).not.toContain(en['error.copyDone'])
  })
})
