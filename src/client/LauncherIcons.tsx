/** Inline SVG glyphs for the Git Launcher cards (existing icon-set style). */

/** Branch glyph for the Git Changes launcher card. */
export function BranchGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="4" cy="3.5" r="1.6" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4" cy="12.5" r="1.6" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="12" cy="3.5" r="1.6" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4 5.1v5.8M12 5.1v1.4c0 1.5-1.2 2.7-2.7 2.7H7.3C6 9.2 5 9.9 4.6 11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/** History glyph for the Git Graph launcher card. */
export function GraphGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="5" cy="3" r="1.6" fill="currentColor" />
      <circle cx="11" cy="8" r="1.6" fill="currentColor" />
      <circle cx="5" cy="13" r="1.6" fill="currentColor" />
      <path d="M5 4.6v6.8M5 8h4.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/** Linked-checkouts glyph for the Git Worktrees launcher card. */
export function WorktreeGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="2.5" width="6.5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
      <rect x="7.5" y="8.5" width="6.5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8.5 5v-.6a1.1 1.1 0 0 1 1.1-1.1h1.1M5 8.5v.6a1.1 1.1 0 0 0-1.1 1.1H2.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}
