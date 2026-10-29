/**
 * Git Graph surface: commit history visualization. Data flows through the
 * controller (paged `git log` with a history scope) and the pure layout
 * engine (active lanes, logical lane identities, visual columns); the rail
 * itself is one canvas layer in a continuous coordinate space, the rows are
 * plain DOM for text and hover. Refs are decorations rendered as badges in
 * the description area — they never own a graph lane.
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { GitCommitSummary } from '../../types.ts'
import type { GitLogScope } from '../../types.ts'
import type { GitClientController } from '../controller.ts'
import { resolveGitController, type GitSessionControllers } from '../session-controllers.ts'
import { effectiveWorkspacePath } from '../workspace-path.ts'
import { GitDetailsHeaderActions } from '../GitDetailsHeaderActions.tsx'
import { GIT_GRAPH_LANE_GAP } from '../graph-geometry.ts'
import { GitGraphCanvas } from '../GitGraphCanvas.tsx'
import { refBadges } from '../ref-badge.ts'
import { RefBadge } from './RefBadge.tsx'
import { useGitWorkspace } from '../use-git-workspace.ts'
import css from '../GitGraphSurface.module.css'
import { describeLocalError, ErrorToast, useErrorToast } from '../error-feedback.tsx'


/** Full composed props for the Git Graph tab body. */
export type GitGraphSurfaceProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'git'>
  & { controller?: GitClientController; gitSessions?: GitSessionControllers }

const GRAPH_SCOPES: readonly GitLogScope[] = ['auto', 'all', 'first-parent']

/** Locale key of one scope's label. */
function scopeLabelKey(scope: GitLogScope): 'graph.scope.auto' | 'graph.scope.all' | 'graph.scope.firstParent' {
  if (scope === 'all') return 'graph.scope.all'
  if (scope === 'first-parent') return 'graph.scope.firstParent'
  return 'graph.scope.auto'
}

/** Open a commit card after the pointer dwells this long on a row. */
const HOVER_OPEN_MS = 400
/** Grace period to move the pointer from a row onto its card. */
const HOVER_CLOSE_MS = 200

/**
 * Hover-card content for one commit row, mirroring what VS Code's history
 * item hover shows: the full subject, the abbreviated hash, author and date,
 * and the ref decorations.
 */
function commitHoverContent(commit: GitCommitSummary, localBranches: ReadonlySet<string>, currentBranch: string | null): ReactNode {
  const badges = refBadges(commit.refs, localBranches, currentBranch)
  return (
    <div className={css.hoverCard}>
      <div className={css.hoverSubject}>{commit.subject}</div>
      <div className={css.hoverMeta}>
        {commit.author} · {commit.date.slice(0, 16).replace('T', ' ')}
      </div>
      <div className={css.hoverHash}>{commit.shortHash}</div>
      {badges.length > 0 && (
        <div className={css.hoverRefs}>
          {badges.map(badge => <RefBadge key={`${badge.kind}:${badge.name}`} badge={badge} />)}
        </div>
      )}
    </div>
  )
}

/** Render the Git Graph surface body. */
export function GitGraphSurface({
  controller: controllerProp, gitSessions, t, useSessions, sessionId,
}: GitGraphSurfaceProps): ReactNode {
  const controller = resolveGitController({ controller: controllerProp, gitSessions, sessionId })
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const errorToast = useErrorToast(state.error)
  const graphToast = useErrorToast(state.graphError)
  const workspacePath = useSessions(list => effectiveWorkspacePath(list.byId[sessionId]))
  const [hoveredRowIndex, setHoveredRowIndex] = useState<number | undefined>(undefined)
  const [cardState, setCardState] = useState<{ index: number; x: number; y: number } | null>(null)
  const [cardPos, setCardPos] = useState<{ left: number; top: number } | null>(null)
  const openTimer = useRef<number | undefined>(undefined)
  const closeTimer = useRef<number | undefined>(undefined)
  const bodyRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)

  useGitWorkspace(controller, workspacePath)

  // Load the first page once a repository is bound. `graphLoaded` separates
  // "not loaded yet" from "loaded but empty" and "load failed": only the
  // first auto-loads, the others wait for an explicit refresh (scope switch,
  // header refresh, or workspace rebind).
  useEffect(() => {
    if (state.repository && !state.graphLoaded && !state.graphLoading) {
      void controller.loadGraph(true)
    }
  }, [controller, state.repository, state.graphLoaded, state.graphLoading])

  // Progressive loading: a sentinel below the last row pulls the next page as
  // soon as it nears the scroll port — and keeps pulling while the history is
  // shorter than the viewport, so short panels fill adaptively. Hosts without
  // IntersectionObserver fall back to the explicit button below.
  useEffect(() => {
    const sentinel = sentinelRef.current
    const root = bodyRef.current
    if (sentinel === null || root === null || !state.graphHasMore || state.graphLoading || state.graphError !== undefined || typeof IntersectionObserver === 'undefined') {
      return
    }
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return
      observer.disconnect()
      void controller.loadMoreGraph()
    }, { root, rootMargin: '50% 0px' })
    observer.observe(sentinel)
    return () => { observer.disconnect() }
  }, [controller, state.graphHasMore, state.graphLoading, state.graphError, state.graphRows.length])

  // Commit hover card: opens at the pointer (not the anchor's right edge, the
  // host HoverCard's only placement), flips to the pointer's left when the
  // viewport lacks room, and gives the pointer a short grace to move onto the
  // card so its text stays readable and selectable.
  const armCard = (index: number, x: number, y: number) => {
    window.clearTimeout(openTimer.current)
    window.clearTimeout(closeTimer.current)
    openTimer.current = window.setTimeout(() => { setCardState({ index, x, y }) }, HOVER_OPEN_MS)
  }
  const dismissCard = () => {
    window.clearTimeout(openTimer.current)
    closeTimer.current = window.setTimeout(() => { setCardState(null) }, HOVER_CLOSE_MS)
  }
  const onRowEnter = (index: number, event: ReactMouseEvent<HTMLLIElement>) => {
    setHoveredRowIndex(index)
    armCard(index, event.clientX, event.clientY)
  }
  const onRowMove = (index: number, event: ReactMouseEvent<HTMLLIElement>) => {
    if (cardState?.index !== index) armCard(index, event.clientX, event.clientY)
  }

  useLayoutEffect(() => {
    if (cardState === null) { setCardPos(null); return }
    const card = cardRef.current
    if (card === null) return
    let left = cardState.x + 12
    if (left + card.offsetWidth > window.innerWidth - 8) left = Math.max(8, cardState.x - card.offsetWidth - 12)
    let top = cardState.y + 14
    if (top + card.offsetHeight > window.innerHeight - 8) top = Math.max(8, cardState.y - card.offsetHeight - 8)
    setCardPos({ left, top })
  }, [cardState])

  // Escape and list scrolling dismiss an open card; unmount cancels timers.
  useEffect(() => {
    if (cardState === null) return
    const body = bodyRef.current
    const dismiss = () => { setCardState(null) }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss() }
    window.addEventListener('keydown', onKey)
    body?.addEventListener('scroll', dismiss)
    return () => {
      window.removeEventListener('keydown', onKey)
      body?.removeEventListener('scroll', dismiss)
    }
  }, [cardState !== null])
  useEffect(() => () => {
    window.clearTimeout(openTimer.current)
    window.clearTimeout(closeTimer.current)
  }, [])

  // Lane columns start one gap in (see buildGraphGeometry), so the rail area
  // is (lanes + 1) columns wide. The row's left padding — 12px sidebar gutter,
  // the rail area, then a 4px margin — lives on each li so the hover band
  // covers the whole row including the lane zone.
  const laneArea = (Math.max(state.graphLaneCount, 1) + 1) * GIT_GRAPH_LANE_GAP
  const localBranches = new Set(state.repository?.branches.map(branch => branch.name) ?? [])
  const currentBranch = state.repository?.branch ?? null
  const cardCommit = cardState === null ? undefined : state.graphRows[cardState.index]?.commit

  return (
    <div className={css.root} data-git-graph-surface="">
      <div className={css.scopeBar} data-git-graph-toolbar="">
        <div className={css.scopeTabs} role="tablist" aria-label={t('details.tabs')}>
          {GRAPH_SCOPES.map(scope => (
            <button
              key={scope}
              type="button"
              role="tab"
              aria-selected={state.graphScope === scope}
              className={css.scopeButton}
              data-scope={scope}
              data-active={state.graphScope === scope || undefined}
              disabled={state.graphLoading}
              onClick={() => { void controller.setGraphScope(scope) }}
            >
              {t(scopeLabelKey(scope))}
            </button>
          ))}
        </div>
        <GitDetailsHeaderActions controller={controller} t={t} compact />
      </div>
      <div className={css.body} ref={bodyRef}>
        {!state.graphLoading && state.workspacePath === undefined && <p className={css.empty}>{t('details.noWorkspace')}</p>}
        {!state.graphLoading && state.repository === null && <p className={css.empty}>{t('details.notRepository')}</p>}
        {state.error !== undefined && <p className={css.empty}>{t('error.local.readRepository')}</p>}
        {state.graphError !== undefined && <p className={css.empty}>{t('error.local.loadGraph')}</p>}
        {errorToast.active && state.error !== undefined && <ErrorToast key={errorToast.seq} report={describeLocalError('error.local.readRepository', state.error, t)} onDone={errorToast.dismiss} t={t} />}
        {graphToast.active && state.graphError !== undefined && <ErrorToast key={graphToast.seq} report={describeLocalError('error.local.loadGraph', state.graphError, t)} onDone={graphToast.dismiss} t={t} />}
        {state.graphLoaded && state.repository != null && state.graphRows.length === 0 && !state.graphLoading && (
          <p className={css.empty}>{t('graph.empty')}</p>
        )}
        <div className={css.rowsWrap}>
          <GitGraphCanvas
            rows={state.graphRows}
            laneCount={state.graphLaneCount}
            hoveredRowIndex={hoveredRowIndex}
            className={css.canvas}
          />
          <ol
            className={css.rows}
            onMouseLeave={() => { setHoveredRowIndex(undefined) }}
          >
            {state.graphRows.map((row, index) => (
              <li
                key={row.commit.hash}
                className={css.row}
                data-row=""
                style={{ paddingLeft: 12 + laneArea + 4 }}
                onMouseEnter={event => { onRowEnter(index, event) }}
                onMouseMove={event => { onRowMove(index, event) }}
                onMouseLeave={dismissCard}
              >
                <div className={css.commitCell}>
                  <span className={css.subject} data-current={row.node.isHead || undefined}>{row.commit.subject}</span>
                  <span className={css.author}>{row.commit.author}</span>
                  {row.commit.refs.length > 0 && (
                    <span className={css.badges}>
                      {refBadges(row.commit.refs, localBranches, currentBranch).map(badge => (
                        <RefBadge key={`${badge.kind}:${badge.name}`} badge={badge} />
                      ))}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
        {cardState !== null && cardCommit !== undefined && createPortal(
          <div
            ref={cardRef}
            className={css.graphCard}
            style={cardPos ?? { left: cardState.x + 12, top: cardState.y + 14, visibility: 'hidden' }}
            onMouseEnter={() => { window.clearTimeout(closeTimer.current) }}
            onMouseLeave={dismissCard}
          >
            {commitHoverContent(cardCommit, localBranches, currentBranch)}
          </div>,
          document.body,
        )}
        {state.graphHasMore && state.repository !== null && state.repository !== undefined && (
          typeof IntersectionObserver === 'undefined'
            ? (
              <button
                type="button"
                className={css.loadMore}
                disabled={state.graphLoading}
                onClick={() => { void controller.loadMoreGraph() }}
              >
                {t('graph.loadMore')}
              </button>
            )
            : state.graphError === undefined
              ? <div ref={sentinelRef} className={css.sentinel} aria-hidden="true" />
              : null
        )}
        {state.graphLoading && <p className={css.loadingHint}>{t('details.loading')}</p>}
      </div>
    </div>
  )
}
