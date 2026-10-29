/** Platform-account rows on the bundle settings page; sign-in changes apply immediately and never join the form save. */
import { useEffect, useId, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Button, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ScopedRemoteScope } from '../../remote/types.ts'
import type { GitLocaleKey } from '../locales.ts'
import type { GitRemoteFeature } from '../remote.ts'
import { GITHUB_SCOPE, instanceHost } from '../remote/remote-view.ts'
import { RemoteAuthControl } from '../remote/RemoteAuthControl.tsx'
import { AccountAvatar } from '../remote/AccountAvatar.tsx'
import { RetireGrantDialog, type RetireToastKey } from './RetireGrantDialog.tsx'
import { ErrorToast, type GitErrorReport } from '../error-feedback.tsx'
import css from './RemoteAccountsSettings.module.css'

const sourceKeys: Record<string, GitLocaleKey> = {
  gh: 'settings.accounts.sourceGh',
  glab: 'settings.accounts.sourceGlab',
  grant: 'settings.accounts.sourceOauth',
  ref: 'settings.accounts.sourceRef',
  'git-credential': 'settings.accounts.sourceGitCredential',
}

function AccountRow({ feature, scope, name, hostPrefix, t }: {
  readonly feature: GitRemoteFeature
  readonly scope: ScopedRemoteScope
  readonly name: string
  readonly hostPrefix?: string
  readonly t: (key: GitLocaleKey) => string
}): ReactNode {
  const controller = feature.accountControllerFor(scope)
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  useEffect(() => { void controller.refreshAccount() }, [controller])
  const cap = state.scopedCapability
  const auth = cap?.auth
  const authenticated = auth?.state === 'authenticated'
  const viewer = cap?.viewer
  let status: string, statusError = false
  if (state.login !== undefined) status = t('settings.accounts.waitingAuth')
  else if (cap === undefined) status = state.error === undefined ? t('settings.accounts.checking') : t('settings.accounts.unreadable')
  else if (authenticated) {
    const source = auth?.source === undefined ? undefined : sourceKeys[auth.source]
    status = [viewer === undefined ? undefined : `@${viewer.login}`, source === undefined ? undefined : t(source)].filter(item => item !== undefined).join(' · ')
  }
  else if (auth?.state === 'anonymous') status = t('settings.accounts.notConnected')
  else if (auth?.state === 'signed-out') status = t('settings.accounts.disconnected')
  else if (auth?.state === 'invalid') { status = t('settings.accounts.invalid'); statusError = true }
  else status = t('settings.accounts.checking')
  if (hostPrefix !== undefined) status = `${hostPrefix} · ${status}`
  return (
    <div className={css.row} role="listitem">
      <AccountAvatar viewer={authenticated ? viewer : undefined} size={32} />
      <div className={css.copy}>
        <span className={css.name}>{name}</span>
        <span className={`${css.status} ${statusError ? css.statusError : ''}`}>{status}</span>
      </div>
      {cap === undefined
        ? <Button variant="outline" size="sm" className={css.action} disabled={state.busy || state.error === undefined} onClick={() => { void controller.refreshAccount() }}>{state.error === undefined ? t('settings.accounts.connect') : t('settings.accounts.retry')}</Button>
        : <RemoteAuthControl capability={cap} viewer={viewer} busy={state.busy} gitlab={scope.provider === 'gitlab'} instance={scope.provider === 'gitlab' ? scope.instance : undefined} controller={controller} triggerLabel={authenticated ? t('settings.accounts.manage') : t('settings.accounts.connect')} t={t} />}
    </div>
  )
}

/** The plugin settings page's sign-in list: GitHub plus every registered GitLab instance. */
export function RemoteAccountsSettings({ feature, summary = false, t }: {
  readonly feature: GitRemoteFeature
  readonly summary?: boolean
  readonly t: (key: GitLocaleKey) => string
}): ReactNode {
  const heading = useId()
  const capability = useSyncExternalStore(feature.subscribe, feature.getSnapshot)
  const accounts = useSyncExternalStore(feature.subscribe, feature.getAccounts)
  const [retireOpen, setRetireOpen] = useState(false)
  const [toast, setToast] = useState<{ seq: number; key: RetireToastKey }>()
  const [failure, setFailure] = useState<{ seq: number; report: GitErrorReport }>()
  if (summary) return <p>{t('settings.accounts.summary')}</p>
  const available = capability.state === 'on' && feature.scoped.available
  return (
    <section className={css.section} aria-labelledby={heading}>
      <div className={css.header}>
        <h3 id={heading} className={css.title}>{t('settings.accounts.title')}</h3>
        <p className={css.description}>{t('settings.accounts.description')}</p>
      </div>
      {!available ? <p className={css.unavailable}>{t('settings.accounts.unavailable')}</p> : (
        <>
        <div className={css.card} role="list">
          <AccountRow feature={feature} scope={GITHUB_SCOPE} name="GitHub" t={t} />
          {(accounts ?? []).filter(account => account.provider === 'gitlab').map(account => {
            const host = instanceHost(account.instance)
            const name = account.label ?? (account.instance === 'https://gitlab.com' ? 'GitLab.com' : host)
            return <AccountRow key={account.instance} feature={feature} scope={{ provider: 'gitlab', instance: account.instance }} name={name} {...(name.toLowerCase() === host.toLowerCase() ? {} : { hostPrefix: host })} t={t} />
          })}
        </div>
        <Button variant="ghost" size="sm" className={css.retireButton} onClick={() => { setRetireOpen(true) }}>{t('settings.accounts.retireButton')}</Button>
        <RetireGrantDialog open={retireOpen} feature={feature} onClose={() => { setRetireOpen(false) }} onDone={key => { setToast(current => ({ seq: (current?.seq ?? 0) + 1, key })) }} onFailure={report => { setFailure(current => ({ seq: (current?.seq ?? 0) + 1, report })) }} t={t} />
        {toast !== undefined && <Toast key={toast.seq} text={t(toast.key)} tone="success" onDone={() => { setToast(undefined) }} />}
        {failure !== undefined && <ErrorToast key={failure.seq} report={failure.report} onDone={() => { setFailure(undefined) }} t={t} />}
        </>
      )}
    </section>
  )
}
