import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RemoteWriteOutcome } from './remote-view.ts'
import type { GitLocaleKey } from '../locales.ts'
import css from '../GitRemoteSurface.module.css'

const stepKeys: Readonly<Record<string, GitLocaleKey>> = {
  comment: 'gitlab.stepComment', approve: 'gitlab.stepApprove', 'close-pr': 'gitlab.stepClose', 'merge-pr': 'gitlab.stepMerge', 'merge-verification': 'gitlab.stepMergeVerification', 'create-pr': 'gitlab.stepCreate',
  'private-ref': 'gitlab.stepPrivateRef', 'tracking-ref': 'gitlab.stepTracking', 'fetch-mapping': 'gitlab.stepMapping', switch: 'gitlab.stepSwitch', upstream: 'gitlab.stepUpstream', 'create-branch': 'gitlab.stepBranch', 'switch-branch': 'gitlab.stepSwitch',
}
const statusKeys: Readonly<Record<string, GitLocaleKey>> = { succeeded: 'gitlab.succeeded', failed: 'gitlab.failed', 'not-sent': 'gitlab.notSent', partial: 'gitlab.partial', unknown: 'gitlab.stepUnknown' }
const resultErrorKeys: Readonly<Record<string, GitLocaleKey>> = { 'merge-method-unverified': 'gitlab.mergeMethodUnverified', 'merge-method-mismatch': 'gitlab.mergeMethodMismatch', 'source-removal-reported': 'gitlab.sourceRemovalReported' }

/** Scoped write receipt: outcome status plus the per-step results the Host reported. */
export function RemoteOutcome({ value, t }: {
  readonly value: RemoteWriteOutcome
  readonly t: (key: GitLocaleKey) => string
}): ReactNode {
  const status = statusKeys[value.outcome]
  const receipt = typeof value.receipt === 'object' && value.receipt !== null ? value.receipt as Record<string, unknown> : {}
  const receiptError = typeof receipt['error'] === 'string' ? receipt['error'] : undefined
  const receiptErrorKey = receiptError === undefined ? undefined : resultErrorKeys[receiptError]
  return (
    <section className={css.section} aria-label={t('gitlab.result')}>
      <strong>{t('gitlab.result')}: {t(status ?? 'gitlab.stepUnknown')}</strong>
      {value.steps.length > 0 && (
        <ul>
          {value.steps.slice(0, 12).map((step, index) => (
            <li key={index}>
              {t(stepKeys[step.kind] ?? 'gitlab.result')}: {t(statusKeys[step.state] ?? 'gitlab.stepUnknown')}
            </li>
          ))}
        </ul>
      )}
      {typeof receipt['branch'] === 'string' && <p className={css.detailMeta}>{receipt['branch']}</p>}
      {typeof receipt['head'] === 'string' && <p className={css.detailMeta}>{receipt['head']}</p>}
      {receiptError !== undefined && <p className={css.note}>{receiptErrorKey === undefined ? receiptError : t(receiptErrorKey)}</p>}
    </section>
  )
}

/**
 * Reconciliation gate after a scoped write whose result was partial or lost.
 * Writes stay locked until the user acknowledges a refreshed result.
 */
export function RemoteBlockedGate({ blockedAction, errorDetails, reconciled, busy, onAcknowledge, t }: {
  readonly blockedAction: string | undefined
  readonly errorDetails: Readonly<Record<string, string | number | boolean>> | undefined
  readonly reconciled: boolean
  readonly busy: boolean
  readonly onAcknowledge: () => void
  readonly t: (key: GitLocaleKey) => string
}): ReactNode {
  return (
    <section className={css.confirmCard} role="alert">
      <p>{t('gitlab.partial')}</p>
      {(blockedAction === 'remote-checkout-pr' || blockedAction === 'remote-issue-branch') && <p>{t('gitlab.localInspect')}</p>}
      {errorDetails?.['commentSucceeded'] === true && <p>{t('gitlab.commentSucceeded')}</p>}
      <p>{t('gitlab.reconcileHint')}</p>
      <Button variant="ghost" size="sm" disabled={busy || !reconciled} onClick={onAcknowledge}>{t('gitlab.reconcile')}</Button>
    </section>
  )
}
