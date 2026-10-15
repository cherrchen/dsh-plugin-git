/**
 * One checkout row shared by the Worktrees surface and the Changes list.
 * Two-line card layout matching the change rows: line one carries the checkout
 * identity (branch as a ref chip — head-toned on the current checkout — or the
 * detached label plus a hash chip), line two the compact path; trailing icon
 * actions mirror `ChangeRow`.
 */
import type { ReactNode } from 'react'
import { IconFolderOpenOutline16 } from '../../compat/dsh-icons.tsx'
import type { GitWorktree } from '../../types.ts'
import type { GitLocaleKey } from '../locales.ts'
import { checkoutPathLabel, repoFolderName } from '../path-display.ts'
import { RefBadge } from '../surfaces/RefBadge.tsx'
import { GitIconButton } from './GitIconButton.tsx'
import css from '../GitDetailsSurface.module.css'

/** Arrow-into-gate glyph for the session enter action. */
function IconGitEnter({ size = 14 }: { size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 8h8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M7.5 4.5 11 8l-3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13.5 3v10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

/**
 * Render one checkout with its identity chip, path, and session actions.
 * @param props - Worktree record, display root, availability flags, and actions.
 * @returns A list item for the checkout list.
 */
export function WorktreeRow({ entry, repositoryRoot, entering, directorySwitchAvailable, onEnter, onReveal, t }: {
  readonly entry: GitWorktree
  readonly repositoryRoot: string
  readonly entering: boolean
  readonly directorySwitchAvailable: boolean
  readonly onEnter: (path: string) => void
  /** Present only when the host offers a native file manager. */
  readonly onReveal?: ((path: string) => void) | undefined
  readonly t: (key: GitLocaleKey) => string
}): ReactNode {
  const label = entry.branch ?? (entry.detached ? t('worktree.detached') : repoFolderName(entry.path))
  return (
    <li
      className={css.worktreeRow}
      data-git-worktree={entry.path}
      {...(entry.current ? { 'data-git-current': '' } : {})}
    >
      <span className={css.worktreeText} title={entry.path}>
        <span className={css.worktreeLine}>
          {entry.branch !== null
            ? <RefBadge badge={{ kind: entry.current ? 'head' : 'branch', name: entry.branch }} />
            : (
              <>
                <span className={css.worktreeName}>{label}</span>
                {entry.head !== null && <span className={css.worktreeHashChip}>{entry.head.slice(0, 7)}</span>}
              </>
            )}
        </span>
        <span className={css.worktreePath}>{checkoutPathLabel(entry.path, repositoryRoot)}</span>
      </span>
      {entry.branch !== null && entry.head !== null && (
        <span className={css.worktreeHash} aria-hidden="true">{entry.head.slice(0, 7)}</span>
      )}
      <span className={css.rowActions}>
        {entry.current ? <span className={css.worktreeCurrent}>{t('worktree.current')}</span> : null}
        {!entry.current && directorySwitchAvailable ? (
          <span data-git-enter-worktree={entry.path}>
            <GitIconButton
              label={t('worktree.use')}
              disabled={entering}
              tooltipSide="bottom"
              onClick={() => { onEnter(entry.path) }}
            >
              <IconGitEnter />
            </GitIconButton>
          </span>
        ) : null}
        {onReveal === undefined ? null : (
          <GitIconButton
            label={t('worktree.reveal')}
            tooltipSide="bottom"
            onClick={() => { onReveal(entry.path) }}
          >
            <IconFolderOpenOutline16 size={14} />
          </GitIconButton>
        )}
      </span>
    </li>
  )
}
