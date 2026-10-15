/**
 * Git Worktrees surface: every checkout of the current repository, the
 * session-enter action, and the creation dialog backed by whichever mode the
 * host reported (`upstream` runtime or the local implementation).
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconPlusOutline16 } from '../../compat/dsh-icons.tsx'
import type { GitClientController } from '../controller.ts'
import { GitDetailsHeaderActions } from '../GitDetailsHeaderActions.tsx'
import { branchWithCheckout, checkoutSuffix } from '../GitWorktreeList.tsx'
import { GitIconButton } from '../details/GitIconButton.tsx'
import { formatLocale } from '../locales.ts'
import { repoFolderName } from '../path-display.ts'
import { resolveGitController, type GitSessionControllers } from '../session-controllers.ts'
import { effectiveWorkspacePath } from '../workspace-path.ts'
import { useGitWorkspace } from '../use-git-workspace.ts'
import type { GitWorktreeFeature } from '../worktree-feature.ts'
import css from '../GitDetailsSurface.module.css'

/** Full composed props for the Git Worktrees tab body. */
export type GitWorktreesSurfaceProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'git'>
  & { controller?: GitClientController; gitSessions?: GitSessionControllers; worktreeFeature?: GitWorktreeFeature }

/** Render the Git Worktrees surface body. */
export function GitWorktreesSurface({
  controller: controllerProp, gitSessions, worktreeFeature, t, useSessions, sessionId,
}: GitWorktreesSurfaceProps): ReactNode {
  const controller = resolveGitController({ controller: controllerProp, gitSessions, sessionId })
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const workspacePath = useSessions(list => effectiveWorkspacePath(list.byId[sessionId]))
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [from, setFrom] = useState('')
  const [createError, setCreateError] = useState<string>()

  useEffect(() => {
    void controller.refresh()
    worktreeFeature?.refresh()
  }, [controller, worktreeFeature])

  useGitWorkspace(controller, workspacePath)

  const repository = state.repository
  const worktrees = (repository?.worktrees ?? []).filter(entry => !entry.bare)
  const mode = state.worktreeMode
  const canCreate = repository != null
    && (mode === 'local' || (mode === 'upstream' && state.directorySwitchAvailable))
  const closeCreate = (): void => {
    setCreating(false)
    setName('')
    setFrom('')
    setCreateError(undefined)
  }
  const submitCreate = (): void => {
    if (!canCreate || state.creatingWorktree || state.enteringWorktree) return
    void controller.createWorktree(
      name.trim() === '' ? undefined : name.trim(),
      from.trim() === '' ? undefined : from.trim(),
    ).then(() => {
      closeCreate()
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      setCreateError(message.trim() === '' ? t('worktree.createFailed') : message)
    })
  }

  const branchLabel = repository !== undefined && repository !== null
    ? branchWithCheckout(
      repository.branch ?? repository.head?.slice(0, 8) ?? 'HEAD',
      checkoutSuffix(repository.checkout?.kind, t),
    )
    : undefined

  return (
    <div className={css.root} data-git-worktrees-surface="">
      <div className={css.branchRow}>
        <span
          className={css.branchChip}
          {...(repository !== undefined && repository !== null ? { title: repository.root } : {})}
          aria-label={t('details.currentBranch')}
        >
          {branchLabel ?? t('details.currentBranch')}
        </span>
        <div className={css.rowActions}>
          <GitIconButton
            label={t('worktree.create')}
            disabled={!canCreate || state.creatingWorktree || state.enteringWorktree}
            onClick={() => { setCreateError(undefined); setCreating(true) }}
          >
            <IconPlusOutline16 size={14} />
          </GitIconButton>
          <GitDetailsHeaderActions controller={controller} t={t} compact />
        </div>
      </div>
      {state.loading && repository === undefined && <p className={css.empty}>{t('details.loading')}</p>}
      {!state.loading && workspacePath === undefined && <p className={css.empty}>{t('details.noWorkspace')}</p>}
      {!state.loading && repository === null && <p className={css.empty}>{t('details.notRepository')}</p>}
      {repository !== undefined && repository !== null && (
        <section className={css.worktreeList} aria-label={t('tab.worktrees')}>
          {mode === 'upstream' ? <p className={css.worktreeNote}>{t('worktree.modeUpstream')}</p> : null}
          {mode === 'local' ? <p className={css.worktreeNote}>{t('worktree.modeLocal')}</p> : null}
          {worktrees.length === 0 ? <p className={css.empty}>{t('worktree.empty')}</p> : null}
          <ul className={css.worktreeItems}>
            {worktrees.map(entry => {
              const label = entry.branch ?? (entry.detached ? t('worktree.detached') : repoFolderName(entry.path))
              return (
                <li key={entry.path} className={css.worktreeItem} data-git-worktree={entry.path}>
                  <span className={css.worktreeName} title={entry.path}>{label}</span>
                  {entry.current ? <span className={css.worktreePath}>{t('worktree.current')}</span> : null}
                  <span className={css.worktreePath}>{repoFolderName(entry.path)}</span>
                  {!entry.current && state.directorySwitchAvailable ? (
                    <button
                      type="button"
                      className={css.worktreeEnter}
                      data-git-enter-worktree={entry.path}
                      disabled={state.enteringWorktree || state.creatingWorktree}
                      onClick={() => { void controller.enterWorktree(entry.path) }}
                    >
                      {t('worktree.use')}
                    </button>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </section>
      )}
      {state.error === undefined ? null : <p className={css.error} role="alert">{state.error}</p>}
      <Modal
        open={creating}
        onClose={closeCreate}
        title={t('worktree.createDialogTitle')}
        closeLabel={t('branch.cancel')}
        footer={(
          <>
            <Button variant="outline" onClick={closeCreate}>{t('branch.cancel')}</Button>
            <Button
              variant="primary"
              disabled={!canCreate || state.creatingWorktree || state.enteringWorktree}
              onClick={submitCreate}
            >
              {t(state.creatingWorktree ? 'worktree.creating' : 'worktree.create')}
            </Button>
          </>
        )}
      >
        <div>
          <label className={css.field}>
            <span>{t('worktree.createName')}</span>
            <Input
              value={name}
              placeholder={t('worktree.createNamePlaceholder')}
              onChange={(event) => { setName(event.target.value) }}
              aria-label={t('worktree.createName')}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submitCreate()
              }}
            />
          </label>
          <label className={css.field}>
            <span>{t('worktree.createBase')}</span>
            <Input
              value={from}
              placeholder={t('worktree.createBasePlaceholder')}
              onChange={(event) => { setFrom(event.target.value) }}
              aria-label={t('worktree.createBase')}
            />
          </label>
          {mode !== 'local' || state.worktreeDirectory === undefined || state.worktreeDirectory === ''
            ? null
            : <p className={css.worktreeNote}>{formatLocale(t('worktree.createDirectoryHint'), { directory: state.worktreeDirectory })}</p>}
          {createError === undefined ? null : <p className={css.error} role="alert">{createError}</p>}
        </div>
      </Modal>
    </div>
  )
}
