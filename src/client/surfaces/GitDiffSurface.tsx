/**
 * Git Diff surface: one changed path per tab. The tab's navigation carries
 * the compared sides (worktree↔index or index↔HEAD): `params` when the
 * opener supplied them, otherwise decoded from the resource address (which
 * session restore replays without params).
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { GitClientController } from '../controller.ts'
import { parseGitDiffAddress, type GitDiffPayload } from '../contract.ts'
import { GitDetailsHeaderActions } from '../GitDetailsHeaderActions.tsx'
import { useGitWorkspace, type GitSessionsHook } from '../use-git-workspace.ts'
import { DiffTab } from '../details/DiffTab.tsx'
import css from '../GitDetailsSurface.module.css'

/** Full composed props for the Git Diff tab body. */
export type GitDiffSurfaceProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'git'>
  & { controller: GitClientController }

/** Render one Git Diff surface body. */
export function GitDiffSurface({ controller, t, useSessions, sessionId, useTabInfo }: GitDiffSurfaceProps): ReactNode {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const sessions = useSessions as GitSessionsHook
  const workspacePath = sessions(list => list.byId[String(sessionId)]?.cwd)
  const { tab } = useTabInfo()
  const { address, revision } = tab.navigation
  const opened = tab.navigation.params as GitDiffPayload | undefined
  const payload = typeof opened?.path === 'string' && opened.path.length > 0
    ? { path: opened.path, staged: opened.staged === true }
    : parseGitDiffAddress(address)

  useGitWorkspace(controller, workspacePath)

  // The navigation owns the compared file; `revision` re-fires the fetch when
  // a repeated open reveals this tab and navigates in place. The effect waits
  // for the workspace binding to settle (repository discovered) — mounting
  // before the shared controller has a repository must not fire a doomed
  // request; once ready, activation and every repository snapshot refresh
  // refetch the diff.
  useEffect(() => {
    if (payload === undefined) return
    if (state.repository === undefined || state.repository === null) return
    void controller.showDiff(payload.path, payload.staged).catch(() => {})
  }, [controller, address, revision, state.repository])

  return (
    <div className={`${css.root} ${css.diffRoot}`} data-git-diff-surface="">
      <div className={css.diffToolbar} data-git-diff-toolbar="">
        <GitDetailsHeaderActions controller={controller} t={t} compact />
      </div>
      <div className={css.body}>
        {payload === undefined && <p className={css.empty}>{t('details.missingDiff')}</p>}
        {state.workspacePath === undefined && <p className={css.empty}>{t('details.noWorkspace')}</p>}
        {state.repository === null && <p className={css.empty}>{t('details.notRepository')}</p>}
        {payload !== undefined && state.repository !== undefined && state.repository !== null && (
          <DiffTab
            repository={state.repository}
            selectedDiff={{ path: payload.path, staged: payload.staged }}
            diff={state.diff}
            clean={false}
            t={t}
            error={state.error}
          />
        )}
      </div>
    </div>
  )
}
