/** Two-step dialog clearing the local grant of a GitLab instance removed from the configuration. */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { canonicalGitLabInstance } from '../../remote/instance-url.ts'
import { ScopedProtocolError } from '../remote-protocol.ts'
import type { GitRemoteFeature } from '../remote.ts'
import type { GitLocaleKey } from '../locales.ts'
import type { GitErrorReport } from '../error-feedback.tsx'
import css from './RemoteAccountsSettings.module.css'

export type RetireToastKey = 'settings.accounts.retireDone' | 'settings.accounts.retireAlready' | 'settings.accounts.retireAbsent'

export function RetireGrantDialog({ open, feature, onClose, onDone, onFailure, t }: {
  readonly open: boolean
  readonly feature: GitRemoteFeature
  readonly onClose: () => void
  /** Completed dispositions close the dialog; the owner shows a section-level toast. */
  readonly onDone: (key: RetireToastKey) => void
  /** Operation failures stay on the confirm step but report through the owner's toast. */
  readonly onFailure: (report: GitErrorReport) => void
  readonly t: (key: GitLocaleKey) => string
}): ReactNode {
  const [input, setInput] = useState('')
  const [error, setError] = useState<GitLocaleKey>()
  const [scope, setScope] = useState<string>()
  const [running, setRunning] = useState(false)
  const next = () => {
    let canonical: string
    try { canonical = canonicalGitLabInstance(input) } catch { setError('settings.accounts.retireInvalid'); return }
    if (!input.startsWith('https://') || canonical.startsWith('ssh://') || canonical.startsWith('git@')) { setError('settings.accounts.retireInvalid'); return }
    if (feature.getAccounts()?.some(account => account.provider === 'gitlab' && account.instance === canonical)) { setError('settings.accounts.retireRegistered'); return }
    setScope(canonical)
    setError(undefined)
  }
  const confirm = () => {
    if (scope === undefined || running) return
    setRunning(true)
    setError(undefined)
    void feature.retireGrant(scope).then(result => {
      setInput('')
      setScope(undefined)
      onClose()
      onDone(result.disposition === 'retired' ? 'settings.accounts.retireDone' : result.disposition === 'already-retired' ? 'settings.accounts.retireAlready' : 'settings.accounts.retireAbsent')
    }).catch((failure: unknown) => {
      const registered = failure instanceof ScopedProtocolError && (failure.reason === 'instance-registered' || failure.details?.['reason'] === 'instance-registered')
      if (registered) { setScope(undefined); setError('settings.accounts.retireRegistered'); return }
      const key = failure instanceof ScopedProtocolError && (failure.reason === 'record-mismatch' || failure.details?.['reason'] === 'record-mismatch') ? 'settings.accounts.retireMismatch' : 'settings.accounts.retireFailed'
      const detail = failure instanceof ScopedProtocolError ? `code: ${failure.code ?? failure.reason ?? 'git/remote-unavailable'}` : failure instanceof Error ? failure.message : String(failure)
      onFailure({ summary: t(key), detail })
    }).finally(() => { setRunning(false) })
  }
  return (
    <Modal open={open} onClose={onClose} title={t('settings.accounts.retireTitle')} closeLabel={t('branch.cancel')}>
      {scope === undefined ? (
        <>
          <p className={css.retireBody}>{t('settings.accounts.retireBody')}</p>
          <label className={css.retireField}>
            <span className={css.retireLabel}>{t('settings.accounts.retireFieldLabel')}</span>
            <Input
              value={input}
              placeholder="https://gitlab.example.com"
              disabled={running}
              onChange={event => { setInput(event.target.value); setError(undefined) }}
              onKeyDown={event => { if (event.key === 'Enter' && input !== '') next() }}
            />
          </label>
          {error !== undefined && <p className={css.retireError} role="alert">{t(error)}</p>}
          <div className={css.retireFooter}>
            <Button variant="outline" size="sm" onClick={onClose}>{t('branch.cancel')}</Button>
            <Button variant="primary" size="sm" disabled={input === '' || running} onClick={next}>{t('settings.accounts.retireNext')}</Button>
          </div>
        </>
      ) : (
        <>
          <p className={css.retireBody}>{t('settings.accounts.retireConfirmPre')} <strong>{scope}</strong>{t('settings.accounts.retireConfirmPost')}</p>
          <div className={css.retireFooter}>
            <Button variant="outline" size="sm" disabled={running} onClick={() => { setScope(undefined); setError(undefined) }}>{t('settings.accounts.retireBack')}</Button>
            <Button variant="primary" size="sm" disabled={running} onClick={confirm}>{t('settings.accounts.retireDelete')}</Button>
          </div>
        </>
      )}
    </Modal>
  )
}
