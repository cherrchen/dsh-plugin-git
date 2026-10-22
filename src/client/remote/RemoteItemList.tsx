import type { ReactNode } from 'react'
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconPlusOutline16 } from '../../compat/dsh-icons.tsx'
import type { RemoteIssue, RemotePull } from '../../remote/provider.ts'
import { GitIconButton } from '../details/GitIconButton.tsx'
import type { GitLocaleKey } from '../locales.ts'
import css from '../GitRemoteSurface.module.css'

function itemStateKey(state: RemoteIssue['state'] | RemotePull['state']): GitLocaleKey {
  if (state === 'closed') return 'remote.stateClosed'
  if (state === 'merged') return 'remote.stateMerged'
  return 'remote.stateOpen'
}

function itemStateTone(state: RemoteIssue['state'] | RemotePull['state']): 'success' | 'neutral' | 'info' {
  if (state === 'closed') return 'neutral'
  if (state === 'merged') return 'info'
  return 'success'
}

/** Pull/issue rows under one section head, with the create-PR icon for pulls. */
export function RemoteItemList({ kind, items, busy, writable, onOpen, onCreate, t }: {
  readonly kind: 'pulls' | 'issues'
  readonly items: readonly (RemotePull | RemoteIssue)[]
  readonly busy: boolean
  readonly writable: boolean
  readonly onOpen: (number: number) => void
  readonly onCreate: () => void
  readonly t: (key: GitLocaleKey) => string
}): ReactNode {
  return (
    <section className={css.section} aria-label={t(kind === 'pulls' ? 'remote.pulls' : 'remote.issues')}>
      <h3 className={css.sectionHead}>
        <span className={css.sectionTitle}>
          {t(kind === 'pulls' ? 'remote.pulls' : 'remote.issues')}
          <span className={css.sectionCount}>{items.length}</span>
        </span>
        <span className={css.sectionActions}>
          {kind === 'pulls' && (
            <GitIconButton label={t('remote.createPr')} disabled={!writable} onClick={onCreate}>
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
