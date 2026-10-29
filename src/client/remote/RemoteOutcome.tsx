import type { ReactNode } from 'react'
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RemoteWriteOutcome } from './remote-view.ts'
import type { GitLocaleKey } from '../locales.ts'

const stepKeys: Readonly<Record<string, GitLocaleKey>> = {
  comment: 'gitlab.stepComment', approve: 'gitlab.stepApprove', 'close-pr': 'gitlab.stepClose', 'merge-pr': 'gitlab.stepMerge', 'merge-verification': 'gitlab.stepMergeVerification', 'create-pr': 'gitlab.stepCreate',
  'private-ref': 'gitlab.stepPrivateRef', 'tracking-ref': 'gitlab.stepTracking', 'fetch-mapping': 'gitlab.stepMapping', switch: 'gitlab.stepSwitch', upstream: 'gitlab.stepUpstream', 'create-branch': 'gitlab.stepBranch', 'switch-branch': 'gitlab.stepSwitch',
}
const statusKeys: Readonly<Record<string, GitLocaleKey>> = { succeeded: 'gitlab.succeeded', failed: 'gitlab.failed', 'not-sent': 'gitlab.notSent', partial: 'gitlab.partial', unknown: 'gitlab.stepUnknown' }
const resultErrorKeys: Readonly<Record<string, GitLocaleKey>> = { 'merge-method-unverified': 'gitlab.mergeMethodUnverified', 'merge-method-mismatch': 'gitlab.mergeMethodMismatch', 'source-removal-reported': 'gitlab.sourceRemovalReported' }
const doneKeys: Readonly<Record<string, GitLocaleKey>> = {
  'remote-comment': 'gitlab.doneComment', 'remote-review': 'gitlab.doneReview', 'remote-checkout-pr': 'gitlab.doneCheckout', 'remote-issue-branch': 'gitlab.doneIssueBranch',
  'create-pr': 'gitlab.doneCreatePr', 'remote-create-pr': 'gitlab.doneCreatePr', 'close-pr': 'gitlab.doneClose', 'remote-close-pr': 'gitlab.doneClose', 'merge-pr': 'gitlab.doneMerge', 'remote-merge-pr': 'gitlab.doneMerge',
}

/** Transient success banner for a scoped write; partial and unknown outcomes surface through the blocked banner. */
export function RemoteOutcomeToast({ outcome, action, seq, onDone, t }: {
  readonly outcome: RemoteWriteOutcome
  readonly action: string | undefined
  readonly seq: number
  readonly onDone: () => void
  readonly t: (key: GitLocaleKey) => string
}): ReactNode {
  const receipt = typeof outcome.receipt === 'object' && outcome.receipt !== null ? outcome.receipt as Record<string, unknown> : {}
  const branch = typeof receipt['branch'] === 'string' ? receipt['branch'] : undefined
  const key = action === undefined ? undefined : doneKeys[action]
  return <Toast key={seq} tone="success" text={`${t(key ?? 'gitlab.succeeded')}${branch === undefined ? '' : ` · ${branch}`}`} onDone={onDone} />
}

/**
 * Blocking notice after a scoped write whose result was partial or lost.
 * The hold is unbounded because the reconcile affordance must outlive a
 * transient cycle: writes stay locked until the refreshed result is
 * acknowledged or the blocking state clears elsewhere.
 */
export function RemoteBlockedToast({ outcome, action, error, errorDetails, reconciled, seq, onAcknowledge, t }: {
  readonly outcome: RemoteWriteOutcome | undefined
  readonly action: string | undefined
  readonly error: string | undefined
  readonly errorDetails: Readonly<Record<string, string | number | boolean>> | undefined
  readonly reconciled: boolean
  readonly seq: number
  readonly onAcknowledge: () => void
  readonly t: (key: GitLocaleKey) => string
}): ReactNode {
  const parts = [t('gitlab.partial')]
  if (action === 'remote-checkout-pr' || action === 'remote-issue-branch') parts.push(t('gitlab.localInspect'))
  if (errorDetails?.['commentSucceeded'] === true) parts.push(t('gitlab.commentSucceeded'))
  for (const step of outcome?.steps ?? []) parts.push(`${t(stepKeys[step.kind] ?? 'gitlab.result')}: ${t(statusKeys[step.state] ?? 'gitlab.stepUnknown')}`)
  const receipt = typeof outcome?.receipt === 'object' && outcome.receipt !== null ? outcome.receipt as Record<string, unknown> : {}
  const receiptError = typeof receipt['error'] === 'string' ? receipt['error'] : undefined
  if (receiptError !== undefined) {
    const key = resultErrorKeys[receiptError]
    parts.push(key === undefined ? receiptError : t(key))
  }
  if (error !== undefined) parts.push(`${error}${errorDetails?.['reason'] === undefined ? '' : ` · ${String(errorDetails['reason'])}`}`)
  if (!reconciled) parts.push(t('gitlab.reconcileHint'))
  return (
    <Toast
      key={`${seq}:${reconciled}`}
      icon={<IconWarningOutlineRegular />}
      holdMs={Infinity}
      text={parts.join(' ')}
      {...(reconciled ? { actions: [{ label: t('gitlab.reconcile'), onClick: onAcknowledge }] } : {})}
      onDone={() => undefined}
    />
  )
}
