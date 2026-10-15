/**
 * Git Changes surface: repository context row, the commit region, and the
 * staged/unstaged/untracked sections. One of three Git tab types rendered in
 * the upstream right sidebar.
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { GitClientController } from '../controller.ts'
import { GitDetailsHeaderActions } from '../GitDetailsHeaderActions.tsx'
import { branchWithCheckout, checkoutSuffix, GitWorktreeList } from '../GitWorktreeList.tsx'
import { resolveGitController, type GitSessionControllers } from '../session-controllers.ts'
import { effectiveWorkspacePath } from '../workspace-path.ts'
import { useGitWorkspace } from '../use-git-workspace.ts'
import { ChangesTab } from '../details/ChangesTab.tsx'
import { CommitRegion } from '../details/CommitRegion.tsx'
import css from '../GitDetailsSurface.module.css'

/** Full composed props for the Git Changes tab body. */
export type GitChangesSurfaceProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'git'>
  & { controller?: GitClientController; gitSessions?: GitSessionControllers; openWorktrees?: () => void }

/** Render the Git Changes surface body. */
export function GitChangesSurface({
  controller: controllerProp, gitSessions, openWorktrees, t, useSessions, sessionId,
}: GitChangesSurfaceProps): ReactNode {
  const controller = resolveGitController({ controller: controllerProp, gitSessions, sessionId })
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const workspacePath = useSessions(list => effectiveWorkspacePath(list.byId[sessionId]))

  useEffect(() => {
    void controller.refresh()
  }, [controller])

  useGitWorkspace(controller, workspacePath)

  const repository = state.repository
  const branchLabel = repository !== undefined && repository !== null
    ? branchWithCheckout(
      repository.branch ?? repository.head?.slice(0, 8) ?? 'HEAD',
      checkoutSuffix(repository.checkout?.kind, t),
    )
    : undefined

  return (
    <div className={css.root} data-git-changes-surface="">
      <div className={css.branchRow}>
        <span
          className={css.branchChip}
          {...(repository !== undefined && repository !== null ? { title: repository.root } : {})}
          {...(repository?.checkout?.kind !== undefined ? { 'data-git-checkout': repository.checkout.kind } : {})}
          aria-label={t('details.currentBranch')}
        >
          {branchLabel ?? t('details.currentBranch')}
        </span>
        <GitDetailsHeaderActions controller={controller} t={t} compact />
      </div>
      {repository !== undefined && repository !== null ? (
        <GitWorktreeList
          worktrees={repository.worktrees ?? []}
          repositoryRoot={repository.root}
          directorySwitchAvailable={state.directorySwitchAvailable === true}
          entering={state.loading || state.enteringWorktree || state.creatingWorktree}
          onEnter={(path) => { void controller.enterWorktree(path) }}
          onReveal={state.desktopAvailable
            ? (path) => { void controller.reveal(path) }
            : undefined}
          onManage={openWorktrees !== undefined && (state.worktreeMode === 'upstream' || state.worktreeMode === 'local')
            ? openWorktrees
            : undefined}
          t={t}
        />
      ) : null}
      {state.loading && repository === undefined && <p className={css.empty}>{t('details.loading')}</p>}
      {!state.loading && workspacePath === undefined && <p className={css.empty}>{t('details.noWorkspace')}</p>}
      {!state.loading && repository === null && <p className={css.empty}>{t('details.notRepository')}</p>}
      {repository == null && state.error !== undefined && <p className={css.error} role="alert">{state.error}</p>}
      {repository !== undefined && repository !== null && (
        <>
          <CommitRegion
            repository={repository}
            controller={controller}
            t={t}
            error={state.error}
            commitMessage={state.commitMessage}
            generating={state.generating}
            generationAvailable={state.generationAvailable}
            generationReason={state.generationReason}
            generationError={state.generationError}
          />
          <div className={css.body}>
            <ChangesTab repository={repository} controller={controller} t={t} loading={state.loading} error={undefined} />
          </div>
        </>
      )}
    </div>
  )
}
