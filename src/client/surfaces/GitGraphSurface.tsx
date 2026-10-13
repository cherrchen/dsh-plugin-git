/**
 * Git Graph surface: commit history visualization. Data flows through the
 * controller (paged `git log` with a history scope) and the pure layout
 * engine (active lanes, logical lane identities, visual columns); the rail
 * itself is one canvas layer in a continuous coordinate space, the rows are
 * plain DOM for text and hover. Refs are decorations rendered as badges in
 * the description area — they never own a graph lane.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
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

/** Render the Git Graph surface body. */
export function GitGraphSurface({
  controller: controllerProp, gitSessions, t, useSessions, sessionId,
}: GitGraphSurfaceProps): ReactNode {
  const controller = resolveGitController({ controller: controllerProp, gitSessions, sessionId })
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const workspacePath = useSessions(list => effectiveWorkspacePath(list.byId[sessionId]))
  const [hoveredRowIndex, setHoveredRowIndex] = useState<number | undefined>(undefined)

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

  // Lane columns start one gap in (see buildGraphGeometry), so the rail area
  // is (lanes + 1) columns wide; text follows a 4px margin after it.
  const laneArea = (Math.max(state.graphLaneCount, 1) + 1) * GIT_GRAPH_LANE_GAP
  const localBranches = new Set(state.repository?.branches.map(branch => branch.name) ?? [])
  const currentBranch = state.repository?.branch ?? null

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
      <div className={css.body}>
        {!state.graphLoading && state.workspacePath === undefined && <p className={css.empty}>{t('details.noWorkspace')}</p>}
        {!state.graphLoading && state.repository === null && <p className={css.empty}>{t('details.notRepository')}</p>}
        {state.graphError !== undefined && <p className={css.error} role="alert">{state.graphError}</p>}
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
            style={{ paddingLeft: laneArea + 4 }}
            onMouseLeave={() => { setHoveredRowIndex(undefined) }}
          >
            {state.graphRows.map((row, index) => (
              <li
                key={row.commit.hash}
                className={css.row}
                data-row=""
                title={`${row.commit.subject}\n${row.commit.shortHash} · ${row.commit.author} · ${row.commit.date.slice(0, 10)}`}
                onMouseEnter={() => { setHoveredRowIndex(index) }}
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
        {state.graphHasMore && state.repository !== null && state.repository !== undefined && (
          <button
            type="button"
            className={css.loadMore}
            disabled={state.graphLoading}
            onClick={() => { void controller.loadMoreGraph() }}
          >
            {t('graph.loadMore')}
          </button>
        )}
        {state.graphLoading && <p className={css.loadingHint}>{t('details.loading')}</p>}
      </div>
    </div>
  )
}
