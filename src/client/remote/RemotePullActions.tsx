import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Input, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RemotePull, ScopedRemotePull } from '../../remote/provider.ts'
import type { GitRemoteActions } from '../../remote/types.ts'
import type { RemoteConfirmation } from './remote-view.ts'
import { IconChevronDownOutline14 } from '../../compat/dsh-icons.tsx'
import type { GitLocaleKey } from '../locales.ts'
import css from '../GitRemoteSurface.module.css'

type RemotePullView = RemotePull | ScopedRemotePull

function methodLabel(method: 'merge' | 'squash', t: (key: GitLocaleKey) => string): string {
  return method === 'squash' ? t('gitlab.squashMerge') : t('gitlab.directMerge')
}

/**
 * PR write actions: verified-head checkout plus close/merge behind the
 * controller-bound two-step confirmation. Every gating flag is computed by
 * the surface so this block stays presentational.
 */
export function RemotePullActions({ pr, actions, writable, confirmation, mergeMethods, checkoutName, viewer, onCheckoutName, onCheckout, onPrepare, onConfirm, onCancel, t }: {
  readonly pr: RemotePullView
  readonly actions: GitRemoteActions | undefined
  readonly writable: boolean
  readonly confirmation: RemoteConfirmation | undefined
  /** Scoped merge methods; undefined or a single entry renders one merge button. */
  readonly mergeMethods?: readonly ('merge' | 'squash')[] | undefined
  readonly checkoutName: string
  readonly viewer: string | undefined
  readonly onCheckoutName: (name: string) => void
  readonly onCheckout: () => void
  readonly onPrepare: (action: 'close' | 'merge', method?: 'merge' | 'squash') => void
  readonly onConfirm: () => void
  readonly onCancel: () => void
  readonly t: (key: GitLocaleKey) => string
}): ReactNode {
  const [menuOpen, setMenuOpen] = useState(false)
  const methods = mergeMethods ?? []
  const multi = methods.length > 1
  const mergeDisabled = !writable || actions?.canMerge === false || pr.state !== 'open'
  const mergeItems = useMemo((): readonly MenuEntry[] => methods.map(method => ({ id: method, label: methodLabel(method, t) })), [methods, t])
  const sha = pr.head.sha
  return (
    <>
      <div className={css.checkoutRow}>
        <Input
          value={checkoutName}
          placeholder={t('remote.checkoutName')}
          aria-label={t('remote.checkoutName')}
          onChange={event => { onCheckoutName(event.target.value) }}
        />
        <Button variant="outline" size="sm" disabled={!writable || sha === null} onClick={onCheckout}>
          {t('remote.checkout')}
        </Button>
      </div>
      <div className={css.actionsRow}>
        <Button
          variant="outline"
          size="sm"
          disabled={!writable || actions?.canClose === false || pr.state !== 'open'}
          onClick={() => { onPrepare('close') }}
        >
          {t('remote.close')}
        </Button>
        {multi ? (
          <Menu
            open={menuOpen}
            items={mergeItems}
            onSelect={id => { setMenuOpen(false); onPrepare('merge', id as 'merge' | 'squash') }}
            onClose={() => { setMenuOpen(false) }}
            anchor={(
              <Button variant="outline" size="sm" disabled={mergeDisabled} onClick={() => { setMenuOpen(open => !open) }}>
                {t('remote.merge')} <IconChevronDownOutline14 size={12} />
              </Button>
            )}
          />
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={mergeDisabled}
            onClick={() => { onPrepare('merge', methods[0]) }}
          >
            {t('remote.merge')}
          </Button>
        )}
      </div>
      {confirmation === undefined ? null : (
        <div className={css.confirmCard} role="alertdialog" aria-label={t('remote.confirm')}>
          <p className={css.confirmText}>
            {t('remote.confirm')} · #{confirmation.number} · {confirmation.sha.slice(0, 12)}{confirmation.method === undefined ? '' : ` · ${methodLabel(confirmation.method, t)}`}{viewer === undefined ? '' : ` · ${viewer}`}
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
