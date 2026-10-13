/** Compact ref chips on graph rows, colored by kind like VS Code's badges. */
import type { ReactNode } from 'react'
import { IconBranchOutline16 } from '../../compat/dsh-icons.tsx'
import type { GitRefBadge } from '../ref-badge.ts'
import css from '../GitGraphSurface.module.css'

/** Hollow-ring glyph marking the checked-out HEAD ref. */
function IconRefHead({ size = 11 }: { size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.4" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="8" cy="8" r="1.8" fill="currentColor" />
    </svg>
  )
}

/** Globe glyph for remote-tracking refs. */
function IconRefRemote({ size = 11 }: { size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.8" stroke="currentColor" strokeWidth="1.2" />
      <ellipse cx="8" cy="8" rx="2.5" ry="5.8" stroke="currentColor" strokeWidth="1" />
      <path d="M2.4 8h11.2" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

/** Tag glyph for tag refs. */
function IconRefTag({ size = 11 }: { size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.5 2.5h5.1l5.4 5.4a1.5 1.5 0 0 1 0 2.2l-3 3a1.5 1.5 0 0 1-2.2 0L2.5 7.8V2.5Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <circle cx="5.4" cy="5.4" r="1.1" fill="currentColor" />
    </svg>
  )
}

/** Kind icon inside one ref chip. */
function RefBadgeIcon({ kind }: { kind: GitRefBadge['kind'] }): ReactNode {
  if (kind === 'head') return <IconRefHead />
  if (kind === 'remote') return <IconRefRemote />
  if (kind === 'tag') return <IconRefTag />
  return <IconBranchOutline16 size={11} />
}

/** One ref decoration chip: kind icon plus the ref's display name. */
export function RefBadge({ badge }: { badge: GitRefBadge }): ReactNode {
  return (
    <span className={css.refBadge} data-ref={badge.kind}>
      <RefBadgeIcon kind={badge.kind} />
      <span className={css.refName}>{badge.name}</span>
    </span>
  )
}
