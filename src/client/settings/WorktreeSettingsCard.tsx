/**
 * Plugin configuration card for the Worktrees feature: a local-mode enable
 * toggle plus the checkout pool directory. Shares the commit-message card's
 * chrome so both sections render identically on every settings surface.
 */
import { useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14 } from '../../compat/dsh-icons.tsx'
import type { WorktreeSettingsCardController } from './worktree-card-controller.ts'
import css from './CommitMessageSettingsCard.module.css'

/** Props the renderer binds for the worktree settings card. */
export type WorktreeSettingsCardProps =
  PropsLocale<'git'>
  & {
    controller: WorktreeSettingsCardController
    /**
     * Plugin-manager view. `summary` is the one-line fallback; `page` is the
     * form. Absent on the legacy settings card, which keeps its own chrome.
     */
    view?: 'summary' | 'page'
  }

/**
 * Render the Git Worktrees settings card.
 * @param props - locale copy, the staged card controller, and an optional plugin-manager view.
 * @returns the card, the page form, a one-line summary, or nothing when the namespace is unavailable.
 */
export function WorktreeSettingsCard(props: WorktreeSettingsCardProps): ReactNode {
  const { controller, t, view } = props
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const [open, setOpen] = useState(false)
  if (view === 'summary') return <p>{t('settings.worktrees.description')}</p>
  if (!state.available) return null
  const title = t('settings.worktrees.title')
  const disabled = !state.writable || state.saving
  const blocked = !state.dirty || state.saving
  const expanded = view === 'page' || open
  const fields = expanded
    ? (
      <div className={css.body}>
        {!state.writable ? <p className={css.readOnly} role="status">{t('settings.readOnly')}</p> : null}
        <div className={css.field}>
          <label className={css.mode}>
            <input
              type="checkbox"
              name="git-worktrees-enabled"
              checked={state.enabled}
              disabled={disabled}
              onChange={(event) => { controller.setEnabled(event.target.checked) }}
            />
            {t('settings.worktrees.enable')}
          </label>
          <p className={css.hint}>{t('settings.worktrees.enableHint')}</p>
        </div>
        <div className={css.field}>
          <label className={css.label} htmlFor="git-worktrees-directory">{t('settings.worktrees.directory')}</label>
          <input
            id="git-worktrees-directory"
            className={css.input}
            value={state.directory}
            placeholder={t('settings.worktrees.directoryPlaceholder')}
            disabled={disabled}
            onChange={(event) => { controller.setDirectory(event.target.value) }}
          />
          <p className={css.hint}>{t('settings.worktrees.directoryHint')}</p>
        </div>
        <div className={css.footer}>
          {state.failed ? <p className={css.failed} role="status">{t('settings.saveFailed')}</p> : null}
          <button
            type="button"
            className={css.discard}
            disabled={!state.dirty || state.saving}
            onClick={() => { controller.discard() }}
          >
            {t('settings.discard')}
          </button>
          <button
            type="button"
            className={css.save}
            disabled={blocked}
            onClick={() => { controller.save() }}
          >
            {t(state.saving ? 'settings.saving' : 'settings.save')}
          </button>
        </div>
      </div>
    )
    : null
  if (view === 'page') return <div data-git-worktrees-settings="">{fields}</div>
  return (
    <li className={open ? `${css.card} ${css.cardOpen}` : css.card} data-git-worktrees-settings="">
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        aria-label={`${t(open ? 'settings.collapse' : 'settings.expand')}: ${title}`}
        onClick={() => { setOpen(!open) }}
      >
        <span className={css.headText}>
          <span className={css.name}>{title}</span>
          <span className={css.description}>{t('settings.worktrees.description')}</span>
        </span>
        {state.dirty ? <span className={css.pending}>{t('settings.unsaved')}</span> : null}
        <IconChevronDownOutline14 className={open ? `${css.chevron} ${css.chevronOpen}` : css.chevron} />
      </button>
      {fields}
    </li>
  )
}
