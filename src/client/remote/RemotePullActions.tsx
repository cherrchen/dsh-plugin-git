import type { ReactNode } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RemotePull } from '../../remote/provider.ts'
import type { GitRemoteActions } from '../../remote/types.ts'
import type { GitLocaleKey } from '../locales.ts'
import css from '../GitRemoteSurface.module.css'

export type RemoteConfirmKind = 'remote-close-pr' | 'remote-merge-pr'

/**
 * PR write actions: verified-head checkout plus close/merge behind the
 * two-step inline confirm. Every gating flag is computed by the surface so
 * this block stays presentational.
 */
export function RemotePullActions({ pr, actions, writable, confirm, checkoutName, viewer, onCheckoutName, onCheckout, onRequest, onConfirm, onCancel, t }: {
  readonly pr: RemotePull
  readonly actions: GitRemoteActions | undefined
  readonly writable: boolean
  readonly confirm: RemoteConfirmKind | undefined
  readonly checkoutName: string
  readonly viewer: string | undefined
  readonly onCheckoutName: (name: string) => void
  readonly onCheckout: () => void
  readonly onRequest: (kind: RemoteConfirmKind) => void
  readonly onConfirm: () => void
  readonly onCancel: () => void
  readonly t: (key: GitLocaleKey) => string
}): ReactNode {
  return (
    <>
      <div className={css.checkoutRow}>
        <Input
          value={checkoutName}
          placeholder={t('remote.checkoutName')}
          aria-label={t('remote.checkoutName')}
          onChange={event => { onCheckoutName(event.target.value) }}
        />
        <Button variant="outline" size="sm" disabled={!writable} onClick={onCheckout}>
          {t('remote.checkout')}
        </Button>
      </div>
      <div className={css.actionsRow}>
        <Button
          variant="outline"
          size="sm"
          disabled={!writable || actions?.canClose === false || pr.state !== 'open'}
          onClick={() => { onRequest('remote-close-pr') }}
        >
          {t('remote.close')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!writable || actions?.canMerge === false || pr.state !== 'open'}
          onClick={() => { onRequest('remote-merge-pr') }}
        >
          {t('remote.merge')}
        </Button>
      </div>
      {confirm === undefined ? null : (
        <div className={css.confirmCard} role="alertdialog" aria-label={t('remote.confirm')}>
          <p className={css.confirmText}>
            {t('remote.confirm')} · #{pr.number} · {pr.head.sha.slice(0, 12)}{viewer === undefined ? '' : ` · ${viewer}`}
          </p>
          <div className={css.confirmActions}>
            <Button variant="primary" size="sm" disabled={!writable} onClick={onConfirm}>
              {t('remote.confirm')}
            </Button>
            <Button variant="outline" size="sm" onClick={onCancel}>
              {t('branch.cancel')}
            </Button>
          </div>
        </div>
      )}
    </>
  )
}
