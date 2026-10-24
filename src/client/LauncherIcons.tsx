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

/** Commit lanes and a curved merge distinguish history from the branch control. */
export function GraphGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 4v2.5M4 9.5V12M11.5 6v2.5c0 2.8-3.2 5-6 5" />
        <circle cx="4" cy="2.5" r="1.5" />
        <circle cx="4" cy="8" r="1.5" />
        <circle cx="4" cy="13.5" r="1.5" />
        <circle cx="11.5" cy="4.5" r="1.5" />
      </g>
    </svg>
  )
}

/** Cloud plus upload/download arrows for the remote platform launcher. */
export function RemoteGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 10h-.5a2.5 2.5 0 0 1-.2-5A4.2 4.2 0 0 1 10.9 4a3 3 0 0 1 2.1 6h-.5" />
        <path d="M6 14V8m-1.5 1.5L6 8l1.5 1.5M10 8v6m-1.5-1.5L10 14l1.5-1.5" />
      </g>
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
