/** Repository-independent platform accounts on the plugin's own settings page. */
import { useEffect, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitRemoteFeature } from '../remote.ts'
import type { GitLocaleKey } from '../locales.ts'
import type { ScopedRemoteCapabilityOn, ScopedRemoteScope } from '../../remote/types.ts'
import { canonicalGitLabInstance } from '../../remote/instance-url.ts'
import { RemoteAuthControl } from '../remote/RemoteAuthControl.tsx'
import { RemoteAvatar } from '../remote/RemoteAvatar.tsx'
import css from './RemoteAccountsSettings.module.css'

const github = { provider: 'github', instance: 'https://github.com' } as const
const pending: ScopedRemoteCapabilityOn = {
  state: 'on', generation: { instanceId: 'pending', revision: 0 }, auth: { state: 'unauthenticated' },
  credential: { configured: false, writable: false }, actions: { canComment: false, canReview: false, canMerge: false, canClose: false, canCreatePr: false },
  loginAvailable: false, automaticRefreshAvailable: false, authMethods: { deviceFlow: { supported: 'unknown' } },
}
function Account({ feature, scope, t }: { feature: GitRemoteFeature; scope: ScopedRemoteScope; t: (key: GitLocaleKey) => string }): ReactNode {
  const controller = feature.authControllerFor(scope)
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const gitlab = scope.provider === 'gitlab'
  useEffect(() => { if (feature.scoped.available) void controller.refreshAccount() }, [controller, feature])
  const capability = state.scopedCapability ?? (!gitlab && state.capability.state === 'on' ? state.capability : undefined)
  const viewer = capability?.viewer
  const connected = capability?.auth.state === 'authenticated'
  return <div className={css.account}>
    {connected && viewer !== undefined ? <RemoteAvatar login={viewer.login} url={viewer.avatarUrl} size={32} /> : <StateDot state={connected ? 'done' : 'idle'} />}
    <div className={css.identity}>
      <strong>{gitlab ? 'GitLab' : 'GitHub'}</strong>
      {gitlab && <span className={css.instance}>{scope.instance}</span>}
      <span className={css.status}>{viewer !== undefined && connected ? `@${viewer.login}` : t(connected ? 'settings.accountsConnected' : 'settings.accountsDisconnected')}</span>
    </div>
    <Button variant="ghost" size="sm" disabled={state.busy || state.login !== undefined || !feature.scoped.available} onClick={() => { void controller.refreshAccount() }}>{t('details.refresh')}</Button>
    <RemoteAuthControl capability={capability ?? pending} viewer={viewer} busy={state.busy} gitlab={gitlab} controller={controller} label={t('settings.accountsManage')} t={t} />
  </div>
}
export function RemoteAccountsSettings({ feature, summary = false, t }: { feature: GitRemoteFeature; summary?: boolean; t: (key: GitLocaleKey) => string }): ReactNode {
  const capability = useSyncExternalStore(feature.subscribe, feature.getSnapshot)
  if (summary) return <p>{t('settings.accountsTitle')}</p>
  const scopes: ScopedRemoteScope[] = [github]
  if (capability.state === 'on') for (const scope of capability.authScopes ?? []) {
    try {
      if (scope.provider === 'gitlab' && canonicalGitLabInstance(scope.instance) === scope.instance && !scopes.some(item => item.instance === scope.instance)) scopes.push(scope)
    } catch { /* Invalid destinations never become account controls. */ }
  }
  return <section className={css.root} aria-label={t('settings.accountsTitle')}>
    <h3>{t('settings.accountsTitle')}</h3>
    <p className={css.hint}>{t('settings.accountsHint')}</p>
    {capability.state === 'off' ? <p className={css.hint}>{t('remote.unavailable')}</p> : scopes.map(scope => <Account key={scope.instance} feature={feature} scope={scope} t={t} />)}
  </section>
}
