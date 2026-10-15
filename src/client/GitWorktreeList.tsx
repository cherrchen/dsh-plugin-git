/** Read-only checkout list. Entering one reuses the host session directory service. */

import type { ReactNode } from 'react'
import type { GitLocaleKey } from './locales.ts'
import { formatLocale } from './locales.ts'
import { WorktreeRow } from './details/WorktreeRow.tsx'
import type { GitWorktree } from '../types.ts'
import css from './GitDetailsSurface.module.css'

/** Locale binder used by the checkout list. */
type Translate = (key: GitLocaleKey) => string

/**
 * Show the other checkouts of the current repository.
 * The enter action is present only when this host can change the surface's session directory.
 * @param props - Worktree records, whether directory changes are available, and the session-scoped enter action.
 * @returns Nothing when this checkout is the only one.
 */
export function GitWorktreeList({ worktrees, repositoryRoot, directorySwitchAvailable, entering, onEnter, onReveal, onManage, t }: {
  readonly worktrees: readonly GitWorktree[]
  readonly repositoryRoot: string
  readonly directorySwitchAvailable: boolean
  readonly entering: boolean
  readonly onEnter: (path: string) => void
  /** Present only when the host offers a native file manager. */
  readonly onReveal?: ((path: string) => void) | undefined
  /** Present only when the Worktrees tab type is registered on this host. */
  readonly onManage?: (() => void) | undefined
  readonly t: Translate
}): ReactNode {
  const others = worktrees
    .filter(entry => !entry.current && !entry.bare)
    .sort((a, b) => (a.branch ?? a.path).localeCompare(b.branch ?? b.path))
  if (others.length === 0) return null
  return (
    <section className={css.worktreeList} aria-label={t('worktree.list')}>
      <h3 className={css.worktreeHeading}>
        {t('worktree.list')}
        {onManage === undefined ? null : (
          <button
            type="button"
            className={css.worktreeEnter}
            onClick={() => { onManage() }}
          >
            {t('worktree.manage')}
          </button>
        )}
      </h3>
      <ul className={css.worktreeItems}>
        {others.map(entry => (
          <WorktreeRow
            key={entry.path}
            entry={entry}
            repositoryRoot={repositoryRoot}
            entering={entering}
            directorySwitchAvailable={directorySwitchAvailable}
            onEnter={onEnter}
            onReveal={onReveal}
            t={t}
          />
        ))}
      </ul>
      {directorySwitchAvailable ? null : <p className={css.worktreeNote}>{t('worktree.unavailable')}</p>}
    </section>
  )
}

/**
 * Visible suffix for a linked checkout.
 * @param kind - Checkout kind from the snapshot.
 * @param t - Locale binder.
 * @returns Suffix text, or undefined for an ordinary main checkout.
 */
export function checkoutSuffix(kind: string | undefined, t: Translate): string | undefined {
  if (kind === 'linked') return t('worktree.linked')
  if (kind === 'bare') return t('worktree.bare')
  return undefined
}

/**
 * Format a branch label with an optional checkout suffix.
 * @param branch - Branch or detached label.
 * @param suffix - Checkout suffix.
 * @returns The combined label.
 */
export function branchWithCheckout(branch: string, suffix: string | undefined): string {
  if (suffix === undefined) return branch
  return formatLocale('{branch} · {suffix}', { branch, suffix })
}
