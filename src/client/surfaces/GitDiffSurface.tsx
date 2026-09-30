/**
 * Git comparison adapter: the official DSH DiffBlock draws one changed path per tab.
 * The tab's navigation carries
 * the compared sides (worktree↔index or index↔HEAD): `params` when the
 * opener supplied them, otherwise decoded from the resource address (which
 * session restore replays without params).
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { GitDiff } from '../../types.ts'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { GitClientController } from '../controller.ts'
import { parseGitDiffAddress, type GitDiffPayload } from '../contract.ts'
import { GitDetailsHeaderActions } from '../GitDetailsHeaderActions.tsx'
import { useGitWorkspace } from '../use-git-workspace.ts'
import { DiffBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import { dshDiffLabels, dshDiffSupportsContext } from '../../compat/dsh-diff.ts'
import { gitFileComparison } from '../git-diff-adapter.ts'
import { splitRepoPath } from '../path-display.ts'
import css from '../GitDetailsSurface.module.css'

/** Identity of one panel's diff result: repository root plus tab address. */
const keyOf = (root: string, address: string): string => `${root}\u0000${address}`

/** Full composed props for the Git Diff tab body. */
export type GitDiffSurfaceProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'git'>
  & { controller: GitClientController }

/** Render one Git Diff surface body. */
export function GitDiffSurface({ controller, t, useSessions, sessionId, useTabInfo }: GitDiffSurfaceProps): ReactNode {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const workspacePath = useSessions(list => list.byId[sessionId]?.cwd)
  const { tab } = useTabInfo()
  const { address, revision } = tab.navigation
  const opened = tab.navigation.params as GitDiffPayload | undefined
  const payload = typeof opened?.path === 'string' && opened.path.length > 0
    ? { path: opened.path, staged: opened.staged === true }
    : parseGitDiffAddress(address)

  useGitWorkspace(controller, workspacePath)

  // Each panel owns its diff result: split panes, float windows, and the
  // staged/worktree pair of one file never overwrite one another's body.
  // `revision` re-fires the fetch when a repeated open reveals this tab and
  // navigates in place. The effect waits for the workspace binding to settle
  // (repository discovered) — mounting before the shared controller has a
  // repository must not fire a doomed request; once ready, activation and
  // every repository snapshot refresh refetch the diff. A completion is
  // discarded when its key (repository root + address) no longer matches this
  // panel, so a stale response can never render.
  const [result, setResult] = useState<{ readonly key: string; readonly diff: GitDiff | undefined; readonly error: string | undefined } | undefined>(undefined)

  useEffect(() => {
    if (payload === undefined) return
    if (state.repository === undefined || state.repository === null) return
    if (state.repository.untracked.includes(payload.path)) return // The repository snapshot supplies the untracked notice.
    const root = state.repository.root
    let active = true
    setResult({ key: keyOf(root, address), diff: undefined, error: undefined })
    void controller.fetchDiff(payload.path, payload.staged).then(
      diff => { if (active) setResult({ key: keyOf(root, address), diff, error: undefined }) },
      error => { if (active) setResult({ key: keyOf(root, address), diff: undefined, error: error instanceof Error ? error.message : String(error) }) },
    )
    return () => { active = false }
  }, [controller, address, revision, state.repository])

  // A failed Refresh retains the previous repository snapshot, so this panel's
  // fetch effect does not refire and its own fetch error stays behind. Show
  // both failures instead of letting one mask the other.
  const fetchError = result?.error
  const error = state.error === undefined
    ? fetchError
    : fetchError === undefined || fetchError === state.error
      ? state.error
      : `${state.error}\n${fetchError}`

  const comparison = useMemo(() => payload === undefined || result?.diff === undefined
    ? undefined
    : gitFileComparison(payload.path, result.diff.text, dshDiffSupportsContext), [payload?.path, result?.diff])
  const labels = dshDiffLabels(t)
  const current = state.repository != null && result?.key === keyOf(state.repository.root, address)
  const untracked = payload !== undefined && state.repository?.untracked.includes(payload.path) === true

  return (
    <div className={`${css.root} ${css.diffRoot}`} data-git-diff-surface="">
      <div className={css.diffToolbar} data-git-diff-toolbar="">
        <GitDetailsHeaderActions controller={controller} t={t} compact />
      </div>
      <div className={css.body}>
        {payload === undefined && <p className={css.empty}>{t('details.missingDiff')}</p>}
        {state.workspacePath === undefined && <p className={css.empty}>{t('details.noWorkspace')}</p>}
        {state.repository === null && <p className={css.empty}>{t('details.notRepository')}</p>}
        {error !== undefined && <p className={css.error} role="alert">{error}</p>}
        {untracked && <p className={css.empty}>{t('details.untrackedDiff')}</p>}
        {payload !== undefined && state.repository != null && !untracked && (
          <div className={css.diffTabBody}>
            <header className={css.diffHeader}>
              <strong>{splitRepoPath(payload.path).name}</strong>
              <span>{payload.path}</span>
              <span className={css.diffMode}>{t(payload.staged ? 'details.stagedLabel' : 'details.workingTree')}</span>
            </header>
            {!current || comparison === undefined
              ? error === undefined && <p className={css.empty}>{t('details.loading')}</p>
              : comparison.kind === 'text'
                ? <>
                    {comparison.newlineChanged && <p className={css.empty}>{t('diff.newline')}</p>}
                    <DiffBlock key={`${state.repository.root}:${address}`} diffs={comparison.diffs} labels={labels} />
                  </>
                : <p className={css.empty} role={comparison.kind === 'invalid' ? 'alert' : undefined}>
                    {t(comparison.kind === 'empty' ? 'details.noChangesDiff' : `diff.${comparison.kind}`)}
                  </p>}
          </div>
        )}
      </div>
    </div>
  )
}
