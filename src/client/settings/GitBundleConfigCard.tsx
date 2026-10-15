/**
 * Combined plugin-manager card: `plugins.bundle.config` is keyed by package
 * name, so the bundle page gets ONE registration hosting both Git sections —
 * commit-message generation and Worktrees — inside a single settings form
 * whose save writes every staged edit across the two namespaces.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { ComponentType, ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsFormLabels, SettingsFormProps, SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
import { NativeSettingsForm } from '../../compat/dsh-settings-form.tsx'
import type { CommitMessageSettingsCardController } from './commit-message-card-controller.ts'
import { CommitMessageSettingsCard } from './CommitMessageSettingsCard.tsx'
import type { WorktreeSettingsCardController } from './worktree-card-controller.ts'
import { WorktreeSettingsCard } from './WorktreeSettingsCard.tsx'
import css from './CommitMessageSettingsCard.module.css'

/** Props the renderer binds for the bundle-level settings card. */
export type GitBundleConfigCardProps =
  PropsLocale<'git'>
  & {
    commitMessage: CommitMessageSettingsCardController
    worktrees: WorktreeSettingsCardController
    /** Plugin-manager view: `summary` renders one line per section; `page` renders the shared form. */
    view?: 'summary' | 'page'
  }

/**
 * The shared form's chrome on hosts that predate `SettingsForm` (DSH
 * 0.1.6): the same notices and a single save, with staged edits dropped
 * when the page unmounts.
 * @param props - the form's copy and state, its controls, and the save and discard actions.
 * @returns the form, or the unavailable line while no namespace is served.
 */
function LocalSettingsForm({ labels, state, onSave, onDiscard, children }: SettingsFormProps): ReactNode {
  const discard = useRef(onDiscard)
  discard.current = onDiscard
  useEffect(() => () => { discard.current() }, [])
  if (!state.available) return <p className={css.formNotice} role="status">{labels.unavailable}</p>
  const blocked = !state.dirty || state.invalid || state.saving
  return (
    <div className={css.form}>
      {!state.writable ? <p className={css.formNotice} role="status">{labels.readOnly}</p> : null}
      {children}
      <div className={css.pageFooter}>
        {state.failed ? <p className={css.pageFailed} role="status">{labels.saveFailed}</p> : null}
        <button type="button" className={css.pageSave} disabled={blocked} onClick={onSave}>
          {state.saving ? labels.saving : labels.save}
        </button>
      </div>
    </div>
  )
}

const PageForm: ComponentType<SettingsFormProps> = NativeSettingsForm ?? LocalSettingsForm

/**
 * Render both Git settings sections on the plugin's bundle page.
 * @param props - injected section controllers, locale copy, and the host view.
 * @returns The two section summaries, the legacy cards, or one shared form.
 */
export function GitBundleConfigCard({ commitMessage, worktrees, view, t }: GitBundleConfigCardProps): ReactNode {
  const commit = useSyncExternalStore(commitMessage.subscribe, commitMessage.getSnapshot)
  const worktree = useSyncExternalStore(worktrees.subscribe, worktrees.getSnapshot)
  if (view === 'summary') {
    return (
      <>
        <CommitMessageSettingsCard controller={commitMessage} t={t} view="summary" />
        <WorktreeSettingsCard controller={worktrees} t={t} view="summary" />
      </>
    )
  }
  if (view === 'page') {
    const shell: SettingsFormShell = {
      available: commit.available || worktree.available,
      // The notice covers every visible section: a namespace the host does not
      // serve contributes nothing to writability either way.
      writable: (!commit.available || commit.writable) && (!worktree.available || worktree.writable),
      dirty: commit.dirty || worktree.dirty,
      // The worktrees drafts accept every text, so only the model section invalidates a save.
      invalid: commit.invalid,
      saving: commit.saving || worktree.saving,
      failed: commit.failed || worktree.failed,
    }
    const labels: SettingsFormLabels = {
      unavailable: t('settings.unavailable'),
      readOnly: t('settings.readOnly'),
      saveFailed: t('settings.saveFailed'),
      save: t('settings.save'),
      saving: t('settings.saving'),
    }
    return (
      <PageForm
        labels={labels}
        state={shell}
        onSave={() => { commitMessage.save(); worktrees.save() }}
        onDiscard={() => { commitMessage.discard(); worktrees.discard() }}
      >
        <CommitMessageSettingsCard controller={commitMessage} t={t} view="page" />
        <WorktreeSettingsCard controller={worktrees} t={t} view="page" />
      </PageForm>
    )
  }
  return (
    <>
      <CommitMessageSettingsCard controller={commitMessage} t={t} />
      <WorktreeSettingsCard controller={worktrees} t={t} />
    </>
  )
}
