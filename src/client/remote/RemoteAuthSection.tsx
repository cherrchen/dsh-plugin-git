import { useId } from 'react'
import type { ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitRemoteCapabilityOn, ScopedRemoteCapabilityOn, GitRemoteAuthSource, GitRemoteAuthState } from '../../remote/types.ts'
import type { GitRemoteViewer } from '../../remote/types.ts'
import type { RemoteLoginAttempt } from './remote-view.ts'
import type { GitLocaleKey } from '../locales.ts'
import { RemoteAvatar } from './RemoteAvatar.tsx'
import { platformCopy } from './platform-copy.ts'
import { RemoteLoginCard } from './RemoteLoginCard.tsx'
import css from '../GitRemoteSurface.module.css'

export type { RemoteLoginAttempt }

function authDot(state: GitRemoteAuthState): 'done' | 'warning' | 'error' | 'idle' {
  if (state === 'authenticated') return 'done'
  if (state === 'invalid') return 'error'
  if (state === 'unauthenticated') return 'warning'
  return 'idle'
}

const sourceLabels: Record<GitRemoteAuthSource | 'glab', GitLocaleKey> = {
  grant: 'remote.authSourceOAuth',
  ref: 'remote.authSourceRef',
  gh: 'remote.authSourceGh',
  glab: 'remote.authSourceGlab',
  'git-credential': 'remote.authSourceGitCredential',
}

function statusCopy(state: GitRemoteAuthState): { readonly headline: GitLocaleKey; readonly hint?: GitLocaleKey } {
  if (state === 'authenticated') return { headline: 'remote.authStatusConnected' }
  if (state === 'signed-out') return { headline: 'remote.authStatusSignedOut', hint: 'remote.authStatusSignedOutHint' }
  if (state === 'invalid') return { headline: 'remote.authStatusInvalid', hint: 'remote.authStatusInvalidHint' }
  return { headline: 'remote.authStatusAnonymous', hint: 'remote.authStatusAnonymousHint' }
}

/** Authentication status card plus a radio choice of connect methods; checked state derives from capability only. */
export function RemoteAuthSection({ capability, viewer, busy, login, loginBrowser, loginCopy, onCopyLogin, onOpenLogin, onSelectMethod, onLogoutOAuth, gitlab = false, onAuth, onLogin, onCancelLogin, t }: {
  readonly capability: GitRemoteCapabilityOn | ScopedRemoteCapabilityOn
  readonly viewer: GitRemoteViewer | undefined
  readonly busy: boolean
  readonly login: RemoteLoginAttempt | undefined
  readonly loginBrowser?: 'opening' | 'opened' | 'manual' | 'failed' | undefined
  readonly loginCopy?: 'copied' | 'failed' | undefined
  readonly onCopyLogin?: (() => void) | undefined
  readonly onOpenLogin?: (() => boolean) | undefined
  readonly onSelectMethod?: ((method: 'cli' | 'oauth') => void) | undefined
  readonly onLogoutOAuth?: (() => void) | undefined
  /** Scoped GitLab instance: CLI radio describes glab and the API/transport auth hint is shown. */
  readonly gitlab?: boolean
  readonly onAuth: (...endpoints: string[]) => void
  readonly onLogin: () => void
  readonly onCancelLogin: (attemptId: string) => void
  readonly t: (key: GitLocaleKey) => string
}): ReactNode {
  const group = useId()
  const { auth } = capability
  const authenticated = auth.state === 'authenticated'
  // A stored grant or signed-out marker would override the chosen method; drop it first.
  const reset = auth.state === 'signed-out' || auth.state === 'invalid' || auth.source === 'grant'
  const status = login === undefined ? statusCopy(auth.state) : { headline: 'remote.loginInProgress' as const }
  const copy = (key: GitLocaleKey): string => platformCopy(t, key, gitlab ? 'gitlab' : 'github')
  const deviceFlow = 'authMethods' in capability ? capability.authMethods.deviceFlow.supported : undefined
  const oauthAvailable = capability.loginAvailable && capability.credential.writable && deviceFlow !== false
  const oauthHint: GitLocaleKey | undefined = deviceFlow === false ? 'remote.oauthUnsupported'
    : !capability.credential.writable ? 'remote.oauthReadOnly'
    : !capability.loginAvailable ? 'remote.oauthNotConfigured'
    : deviceFlow === 'unknown' ? 'remote.oauthUnverified' : undefined
  const methodsBusy = busy || login !== undefined
  const cachedOAuth = capability.authSelection?.oauthCached === true
  const cliAvailable = capability.authSelection?.cliAvailable !== false
  const cliSource = gitlab ? 'glab' : 'gh'
  const source = authenticated && auth.source !== undefined
    ? gitlab && auth.source === 'ref' ? 'gitlab.authSourceRef' : sourceLabels[auth.source] ?? 'remote.authSourceUnknown'
    : 'remote.authSourceUnknown'
  const subline = login === undefined && authenticated && auth.source !== cliSource && auth.source !== 'grant' ? source : undefined
  return (
    <section className={css.authSection} aria-label={t('remote.auth')}>
      <div className={css.authCard}>
        <div className={css.authStatus}>
          <div className={css.authIdentity}>
            {login === undefined && authenticated && viewer !== undefined
              ? <RemoteAvatar login={viewer.login} url={viewer.avatarUrl} size={32} />
              : <StateDot state={login === undefined ? authDot(auth.state) : 'idle'} />}
            <div className={css.authIdentityText}>
              <strong>{copy(status.headline)}</strong>
              {login === undefined && authenticated && viewer !== undefined && <span className={css.authLogin}>@{viewer.login}</span>}
              {status.hint !== undefined && <span className={css.methodHint}>{copy(status.hint)}</span>}
              {subline !== undefined && <span className={css.methodHint}>{copy(subline)}</span>}
            </div>
          </div>
          {(cachedOAuth || auth.source === 'grant') && (
            <Button variant="ghost" size="sm" onClick={() => { if (onLogoutOAuth !== undefined) onLogoutOAuth(); else onAuth('remote-sign-out') }}>
              {t('remote.oauthLogout')}
            </Button>
          )}
        </div>
      </div>
      <div className={css.authChoices} role="radiogroup" aria-label={t('remote.authMethods')}>
        <span className={css.authMethods}>{t('remote.authMethods')}</span>
        <div className={css.authMethod}>
        <label className={css.radioRow}>
          <input
            type="radio"
            name={group}
            checked={authenticated && auth.source === cliSource}
            disabled={methodsBusy || !cliAvailable}
            onChange={() => {
              if (methodsBusy || !cliAvailable) return
              if (capability.authSelection !== undefined && onSelectMethod !== undefined) onSelectMethod('cli')
              else onAuth(...(reset ? ['remote-clear-grant'] : []), 'remote-retry-auth')
            }}
          />
          <span>{t(gitlab ? 'remote.authSourceGlab' : 'remote.authSourceGh')}</span>
        </label>
        {!cliAvailable && <span className={css.radioHint}>{t('remote.cliUnavailable')}</span>}
        <span className={css.radioHint}>{t(gitlab ? 'remote.glabMethodHint' : 'remote.ghMethodHint')}</span>
        {!authenticated && login === undefined && <span className={css.radioHint}>{t(gitlab ? 'remote.glabLoginHint' : 'remote.ghLoginHint')}</span>}
        </div>
        <div className={css.authMethod}>
        <label className={css.radioRow}>
          <input
            type="radio"
            name={group}
            checked={authenticated && auth.source === 'grant'}
            disabled={methodsBusy || !oauthAvailable}
            aria-describedby={oauthHint === undefined || login !== undefined ? undefined : `${group}-oauth-hint`}
            onChange={() => {
              if (methodsBusy || !oauthAvailable) return
              if (capability.authSelection !== undefined && onSelectMethod !== undefined) onSelectMethod('oauth')
              else onLogin()
            }}
          />
          <span>{copy('remote.authSourceOAuth')}</span>
        </label>
        <span className={css.radioHint}>{copy('remote.oauthMethodHint')}</span>
        {cachedOAuth && login === undefined && <span className={css.radioHint}>{t('remote.oauthSaved')}</span>}
        {login === undefined && oauthHint !== undefined && <span id={`${group}-oauth-hint`} className={css.radioHint}>{t(oauthHint)}</span>}
        </div>
        {login !== undefined && (
          <RemoteLoginCard login={login} browser={loginBrowser} copied={loginCopy} onCopy={onCopyLogin} onOpen={onOpenLogin} onCancel={() => { onCancelLogin(login.attemptId) }} t={copy} />
        )}
      </div>
      {gitlab && <p className={css.note}>{t('gitlab.authHint')}</p>}
    </section>
  )
}
