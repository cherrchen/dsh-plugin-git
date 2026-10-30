/** Friendly, copyable error reporting: a short localized summary in a toast, raw detail behind a copy action. */
import { useCallback, useState } from 'react'
import type { ReactNode } from 'react'
import { IconWarningOutline16 } from '../compat/dsh-icons.tsx'
import { Toast } from '../compat/dsh-toast.tsx'
import { platformCopy } from './remote/platform-copy.ts'
import type { GitLocaleKey } from './locales.ts'

export interface GitErrorReport {
  /** Short localized text the toast shows. */
  readonly summary: string
  /** Technical detail (code plus wire-allowlisted fields) copied on request. */
  readonly detail: string
}

/** Maps a remote error code/reason to plain-language copy; unknown failures fall back to a connectivity notice. */
export function describeRemoteError(error: string, details: Readonly<Record<string, string | number | boolean>> | undefined, provider: 'github' | 'gitlab' | undefined, t: (key: GitLocaleKey) => string): GitErrorReport {
  const reason = details?.['reason']
  let key: GitLocaleKey
  if (error === 'git/unauthenticated') key = 'error.remote.unauthenticated'
  else if (error === 'git/signed-out') key = 'error.remote.signedOut'
  else if (error === 'git/insufficient-scope') key = reason === 'sso-required' ? 'error.remote.sso' : 'error.remote.noPermission'
  else if (error === 'git/rate-limited') key = 'error.remote.rateLimited'
  else if (error === 'git/head-moved') key = 'error.remote.headMoved'
  else if (error === 'git/remote-identity-mismatch' || error === 'identity-changed') key = 'error.remote.identityChanged'
  else if (error === 'git/write-result-unknown') key = 'error.remote.writeUnknown'
  else if (error === 'stale-confirmation') key = 'error.remote.staleConfirmation'
  else if (error === 'Git checkout needs attention') key = 'error.remote.checkout'
  else if (error === 'git/remote-unavailable' && (reason === 'instance-removed' || reason === 'provider-unavailable')) key = 'error.remote.instanceUnavailable'
  else if (error === 'git/remote-unavailable' && reason === 'not-supported') key = 'error.remote.notSupported'
  else key = 'error.remote.unreachable'
  const lines = [`code: ${error}`]
  for (const [name, value] of Object.entries(details ?? {})) lines.push(`${name}: ${String(value)}`)
  return { summary: platformCopy(t, key, provider), detail: lines.join('\n') }
}

/** Local Git operations carry the raw message only behind the copy action. */
export function describeLocalError(summaryKey: GitLocaleKey, message: string, t: (key: GitLocaleKey) => string): GitErrorReport {
  return { summary: t(summaryKey), detail: message }
}

/** Invoke during the click, while turning synchronous clipboard failures into rejected writes. */
export async function copyErrorDetails(detail: string, copy?: (text: string) => Promise<void>): Promise<void> {
  if (copy !== undefined) { await copy(detail); return }
  if (typeof navigator === 'undefined' || typeof navigator.clipboard?.writeText !== 'function') throw new Error('clipboard-unavailable')
  await navigator.clipboard.writeText(detail)
}

/** Warning toast with a copy-details action; a copy result replaces the banner. */
export function ErrorToast({ report, holdMs = 6000, onDone, copy, t }: {
  readonly report: GitErrorReport
  readonly holdMs?: number
  readonly onDone: () => void
  /** Clipboard writer, e.g. a desktop-aware path; defaults to navigator.clipboard. */
  readonly copy?: ((text: string) => Promise<void>) | undefined
  readonly t: (key: GitLocaleKey) => string
}): ReactNode {
  const [result, setResult] = useState<'copied' | 'failed'>()
  if (result !== undefined) {
    return <Toast text={result === 'copied' ? t('error.copyDone') : t('error.copyFailed')} {...(result === 'copied' ? { tone: 'success' as const } : { icon: <IconWarningOutline16 /> })} onDone={onDone} />
  }
  return (
    <Toast
      text={report.summary}
      icon={<IconWarningOutline16 />}
      holdMs={holdMs}
      actions={[{
        prefix: t('error.copyPrefix'),
        label: t('error.copyDetails'),
        onClick: () => {
          void copyErrorDetails(report.detail, copy).then(() => { setResult('copied') }, () => { setResult('failed') })
        },
      }]}
      onDone={onDone}
    />
  )
}

/**
 * Shows a toast each time `source` becomes a defined, different value; hides when the
 * source clears or the banner finishes. An identical error re-shows only after the
 * source was cleared in between, so controllers must clear their error on retry.
 */
export function useErrorToast(source: unknown): { readonly seq: number; readonly active: boolean; readonly dismiss: () => void } {
  const [state, setState] = useState<{ seq: number; current: unknown; visible: boolean }>({ seq: 0, current: undefined, visible: false })
  if (!Object.is(source, state.current)) setState(current => ({ seq: source === undefined ? current.seq : current.seq + 1, current: source, visible: source !== undefined }))
  const dismiss = useCallback(() => { setState(current => ({ ...current, visible: false })) }, [])
  return { seq: state.seq, active: state.visible, dismiss }
}
