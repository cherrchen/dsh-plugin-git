/**
 * Plugin configuration card for commit-message generation: session-model
 * inherit vs a pinned provider route, plus the system-prompt override.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Input, Menu, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconChevronDownOutline14 } from '../../compat/dsh-icons.tsx'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { CommitMessageSettingsCardController } from './commit-message-card-controller.ts'
import { commitMessageModelKey } from './commit-message-card-controller.ts'
import css from './CommitMessageSettingsCard.module.css'

/** Props the renderer binds for the commit-message settings card. */
export type CommitMessageSettingsCardProps =
  PropsLocale<'git'>
  & {
    controller: CommitMessageSettingsCardController
    /**
     * Plugin-manager view. `summary` is the one-line fallback; `page` is the
     * form. Absent on the legacy settings card, which keeps its own chrome.
     */
    view?: 'summary' | 'page'
  }

/** Menu row id for the session-model choice; every other row id is a candidate key. */
const INHERIT_ITEM_ID = 'session-model'

/**
 * Render the Git commit-message generation card.
 * @param props - locale copy, the staged card controller, and an optional plugin-manager view.
 * @returns the card, the page form, a one-line summary, or nothing when the namespace is unavailable.
 */
export function CommitMessageSettingsCard(props: CommitMessageSettingsCardProps): ReactNode {
  const { controller, t, view } = props
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const [open, setOpen] = useState(false)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const saveStarted = useRef(false)
  useEffect(() => {
    if (view === 'page' || view === 'summary') return
    if (state.saving) {
      saveStarted.current = true
      return
    }
    if (!saveStarted.current) return
    saveStarted.current = false
    if (!state.dirty && !state.failed) setOpen(false)
  }, [state.dirty, state.failed, state.saving, view])
  if (view === 'summary') return <p>{t('settings.description')}</p>
  if (!state.available) return null
  const title = t('settings.title')
  const disabled = !state.writable || state.saving
  const blocked = !state.dirty || state.invalid || state.saving
  const selectedKey = state.provider !== '' && state.model !== ''
    ? commitMessageModelKey({ provider: state.provider, model: state.model })
    : ''
  const grouped: Array<{ provider: string; name: string; candidates: Array<(typeof state.candidates)[number]> }> = []
  for (const candidate of state.candidates) {
    if (!candidate.available) continue
    const group = grouped.find(entry => entry.provider === candidate.provider)
    if (group === undefined) grouped.push({ provider: candidate.provider, name: candidate.providerName, candidates: [candidate] })
    else group.candidates.push(candidate)
  }
  const unavailable = state.candidates.filter(candidate => !candidate.available)
  const selected = state.candidates.find(candidate => candidate.key === selectedKey)
  const selectedLabel = state.mode === 'inherit'
    ? t('settings.modelInherit')
    : selected === undefined
      ? t('settings.modelSelectPlaceholder')
      : selected.available
        ? `${selected.modelName} (${selected.provider}/${selected.model})`
        : `${selected.modelName} (${t('settings.modelUnavailable')})`
  const modelItems: MenuEntry[] = [{ id: INHERIT_ITEM_ID, label: t('settings.modelInherit') }]
  if (state.catalogStatus === 'loading') {
    modelItems.push({ id: 'catalog-loading', label: t('settings.catalogLoading'), disabled: true })
  }
  if (grouped.length > 0) modelItems.push({ type: 'separator', id: 'catalog-groups' })
  for (const group of grouped) {
    modelItems.push({ type: 'label', id: `catalog-${group.provider}`, text: group.name })
    for (const candidate of group.candidates) {
      modelItems.push({ id: candidate.key, label: `${candidate.modelName} (${candidate.provider}/${candidate.model})` })
    }
  }
  if (unavailable.length > 0) {
    modelItems.push({ type: 'separator', id: 'catalog-retained' })
    for (const candidate of unavailable) {
      modelItems.push({ id: candidate.key, label: `${candidate.modelName} (${t('settings.modelUnavailable')})` })
    }
  }
  // A catalog that settles without one advertised route leaves the typed
  // provider/model pair as the only way to pin a custom route.
  const manualRoute = state.candidates.length === 0
    && (state.catalogStatus === 'ready' || state.catalogStatus === 'error')
  const fields = (
    <>
      <div className={css.field}>
        <span className={css.label} id="git-commit-message-model">{t('settings.model')}</span>
        <Menu
          open={modelMenuOpen}
          onClose={() => { setModelMenuOpen(false) }}
          items={modelItems}
          selectedId={state.mode === 'inherit' ? INHERIT_ITEM_ID : selectedKey}
          onSelect={(id) => {
            setModelMenuOpen(false)
            if (id === INHERIT_ITEM_ID) controller.setMode('inherit')
            else controller.setModel(id)
          }}
          align="start"
          portal
          anchor={(
            <button
              type="button"
              className={css.selector}
              aria-haspopup="menu"
              aria-expanded={modelMenuOpen}
              aria-labelledby="git-commit-message-model git-commit-message-model-value"
              disabled={disabled}
              onClick={() => {
                if (!modelMenuOpen && state.catalogStatus === 'idle') controller.retryCatalog()
                setModelMenuOpen(!modelMenuOpen)
              }}
            >
              <span className={css.selectorValue} id="git-commit-message-model-value">{selectedLabel}</span>
              <IconChevronDownOutline14 className={css.selectorChevron} />
            </button>
          )}
        />
        {state.catalogStatus === 'loading'
          ? <p className={css.notice} role="status">{t('settings.catalogLoading')}</p>
          : null}
        {state.catalogStatus === 'error'
          ? (
            <div className={css.catalogError} role="alert">
              <span>{t('settings.catalogFailed')}</span>
              <Button variant="outline" size="sm" disabled={state.saving} onClick={() => { controller.retryCatalog() }}>
                {t('settings.catalogRetry')}
              </Button>
            </div>
          )
          : null}
        {manualRoute
          ? (
            <>
              {state.catalogStatus === 'ready'
                ? <p className={css.notice}>{t('settings.catalogEmpty')}</p>
                : null}
              <label className={css.label} htmlFor="git-commit-message-provider">{t('settings.provider')}</label>
              <Input
                id="git-commit-message-provider"
                value={state.provider}
                disabled={disabled}
                onChange={(event) => { controller.setProviderText(event.target.value) }}
              />
              <label className={css.label} htmlFor="git-commit-message-model-id">{t('settings.modelId')}</label>
              <Input
                id="git-commit-message-model-id"
                value={state.model}
                disabled={disabled}
                onChange={(event) => { controller.setModelText(event.target.value) }}
              />
            </>
          )
          : null}
        {state.invalid ? <p className={css.invalid}>{t('settings.customRequired')}</p> : null}
        <p className={css.hint}>{t('settings.modelHint')}</p>
      </div>
      <div className={css.field}>
        <label className={css.label} htmlFor="git-commit-message-system">{t('settings.systemPrompt')}</label>
        <textarea
          id="git-commit-message-system"
          className={css.textarea}
          value={state.systemPrompt}
          placeholder={t('settings.systemPromptPlaceholder')}
          disabled={disabled}
          onChange={(event) => { controller.setSystemPrompt(event.target.value) }}
        />
        <p className={css.hint}>{t('settings.systemPromptHint')}</p>
      </div>
    </>
  )
  // The bundle page composes every section's rows into one shared form, so
  // the page view carries only the fields — notice and save live on the form.
  if (view === 'page') {
    return <div className={css.pageSection} data-git-commit-message-settings="">{fields}</div>
  }
  return (
    <li className={open ? `${css.card} ${css.cardOpen}` : css.card} data-git-commit-message-settings="">
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        aria-label={`${t(open ? 'settings.collapse' : 'settings.expand')}: ${title}`}
        onClick={() => { setOpen(!open) }}
      >
        <span className={css.headText}>
          <span className={css.name}>{title}</span>
          <span className={css.description}>{t('settings.description')}</span>
        </span>
        {state.dirty ? <Tag tone="neutral" className={css.pending}>{t('settings.unsaved')}</Tag> : null}
        <IconChevronDownOutline14 className={open ? `${css.chevron} ${css.chevronOpen}` : css.chevron} />
      </button>
      {open
        ? (
          <div className={css.body}>
            {!state.writable ? <p className={css.readOnly} role="status">{t('settings.readOnly')}</p> : null}
            {fields}
            <div className={css.footer}>
              {state.failed ? <p className={css.failed} role="status">{t('settings.saveFailed')}</p> : null}
              <Button
                variant="outline"
                size="sm"
                disabled={!state.dirty || state.saving}
                onClick={() => { controller.discard() }}
              >
                {t('settings.discard')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={blocked}
                onClick={() => { controller.save() }}
              >
                {t(state.saving ? 'settings.saving' : 'settings.save')}
              </Button>
            </div>
          </div>
        )
        : null}
    </li>
  )
}
