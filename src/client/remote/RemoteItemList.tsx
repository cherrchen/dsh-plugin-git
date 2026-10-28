import type { ReactNode } from 'react'
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconPlusOutline16 } from '../../compat/dsh-icons.tsx'
import type { RemoteItem } from './remote-view.ts'
import { GitIconButton } from '../details/GitIconButton.tsx'
import type { GitLocaleKey } from '../locales.ts'
import css from '../GitRemoteSurface.module.css'

function itemStateKey(state: RemoteItem['state']): GitLocaleKey {
  if (state === 'closed') return 'remote.stateClosed'
  if (state === 'merged') return 'remote.stateMerged'
  if (state === 'unknown') return 'remote.stateUnknown'
  return 'remote.stateOpen'
}

function itemStateTone(state: RemoteItem['state']): 'success' | 'neutral' | 'info' | 'warning' {
  if (state === 'closed') return 'neutral'
  if (state === 'merged') return 'info'
  if (state === 'unknown') return 'warning'
  return 'success'
}

/** Pull/issue rows under one section head, with the create-PR icon for pulls. */
export function RemoteItemList({ kind, items, busy, writable, canCreate, pullsLabel = 'remote.pulls', onOpen, onCreate, t }: {
  readonly kind: 'pulls' | 'issues'
  readonly items: readonly RemoteItem[]
  readonly busy: boolean
  readonly writable: boolean
  /** Create action must also be supported by the target's operation facts. */
  readonly canCreate?: boolean | undefined
  readonly pullsLabel?: GitLocaleKey
  readonly onOpen: (number: number) => void
  readonly onCreate: () => void
  readonly t: (key: GitLocaleKey) => string
}): ReactNode {
  const titleKey = kind === 'pulls' ? pullsLabel : 'remote.issues'
  return (
    <section className={css.section} aria-label={t(titleKey)}>
      <h3 className={css.sectionHead}>
        <span className={css.sectionTitle}>
          {t(titleKey)}
          <span className={css.sectionCount}>{items.length}</span>
        </span>
        <span className={css.sectionActions}>
          {kind === 'pulls' && (
            <GitIconButton label={t('remote.createPr')} disabled={!writable || canCreate === false} onClick={onCreate}>
              <IconPlusOutline16 size={14} />
            </GitIconButton>
          )}
        </span>
      </h3>
      <ul className={css.itemList}>
        {items.map(item => (
          <li key={item.number}>
            <button
              type="button"
              className={css.itemRow}
              aria-disabled={busy || undefined}
              onClick={() => { if (!busy) onOpen(item.number) }}
            >
              <span className={css.itemMain}>
                <span className={css.itemTitle}>{item.title}</span>
                <span className={css.itemMeta}>
                  <span className={css.itemNumber}>#{item.number}</span>
                  {item.author === null ? null : <span className={css.itemAuthor}>{item.author.login}</span>}
                </span>
              </span>
              <Tag tone={itemStateTone(item.state)}>{t(itemStateKey(item.state))}</Tag>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
