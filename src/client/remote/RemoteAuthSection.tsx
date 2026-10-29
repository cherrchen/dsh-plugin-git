import { useId } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitRemoteCapabilityOn, ScopedRemoteCapabilityOn, GitRemoteAuthState } from '../../remote/types.ts'
import type { GitRemoteViewer } from '../../remote/types.ts'
import type { RemoteLoginAttempt, RemoteLoginStatus } from './remote-view.ts'
import { instanceHost } from './remote-view.ts'
import type { GitLocaleKey } from '../locales.ts'
import { AccountAvatar } from './AccountAvatar.tsx'
import { platformCopy } from './platform-copy.ts'
import { RemoteLoginCard } from './RemoteLoginCard.tsx'
import css from '../GitRemoteSurface.module.css'

export type { RemoteLoginAttempt }

const sourceLabels: Record<string, GitLocaleKey> = {
  gh: 'settings.accounts.sourceGh',
  glab: 'settings.accounts.sourceGlab',
  grant: 'settings.accounts.sourceOauth',
  ref: 'settings.accounts.sourceRef',
  'git-credential': 'settings.accounts.sourceGitCredential',
}

const loginFeedback: Record<RemoteLoginStatus, GitLocaleKey> = {
  requesting: 'remote.loadingAuth', waiting: 'remote.waitingAuth', verifying: 'remote.loginVerifying',
  connected: 'remote.loginConnected', cancelled: 'remote.loginCancelled', expired: 'remote.loginExpired',
  denied: 'remote.loginDenied', failed: 'remote.loginFailed', unavailable: 'remote.loginUnavailable',
}

function headline(state: GitRemoteAuthState): GitLocaleKey {
  if (state === 'authenticated') return 'remote.authStatusConnected'
  if (state === 'signed-out') return 'remote.authStatusSignedOut'
  if (state === 'invalid') return 'remote.authStatusInvalid'
  return 'remote.authStatusAnonymous'
}

function hint(state: GitRemoteAuthState): GitLocaleKey | undefined {
  if (state === 'signed-out') return 'remote.authStatusSignedOutHint'
  if (state === 'invalid') return 'remote.authStatusInvalidHint'
  if (state === 'anonymous' || state === 'unauthenticated') return 'remote.authStatusAnonymousHint'
  return undefined
}

/** Identity card, sign-in method choice, and the device-login card for the shared auth dialog. */
export function RemoteAuthSection({ capability, viewer, busy, login, loginBrowser, loginCopy, onCopyLogin, onOpenLogin, onSelectMethod, onLogoutOAuth, gitlab = false, instance, loginStatus, onAuth, onLogin, onCancelLogin, t }: {
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
  /** Scoped GitLab instance: CLI copy describes glab and the GitLab notes are shown. */
  readonly gitlab?: boolean
  /** Canonical GitLab instance URL; non-gitlab.com values prefix the status line with the host. */
  readonly instance?: string | undefined
  /** Latest login outcome feedback; replaces the second status line when present. */
  readonly loginStatus?: RemoteLoginStatus | undefined
  readonly onAuth: (...endpoints: string[]) => void
  readonly onLogin: () => void
  readonly onCancelLogin: (attemptId: string) => void
  readonly t: (key: GitLocaleKey) => string
}): ReactNode {
  const group = useId()
  const { auth } = capability
  const platform = gitlab ? 'gitlab' as const : 'github' as const
  const authenticated = auth.state === 'authenticated'
  // A stored grant or signed-out marker would override the chosen method; drop it first.
  const reset = auth.state === 'signed-out' || auth.state === 'invalid' || auth.source === 'grant'
  const copy = (key: GitLocaleKey): string => platformCopy(t, key, platform)
  const deviceFlow = 'authMethods' in capability ? capability.authMethods.deviceFlow.supported : undefined
  const oauthAvailable = capability.loginAvailable && capability.credential.writable && deviceFlow !== false
  const oauthHintKey: GitLocaleKey | undefined = deviceFlow === false ? 'remote.oauthUnsupported'
    : !capability.credential.writable ? 'remote.oauthReadOnly'
    : !capability.loginAvailable ? 'remote.oauthNotConfigured'
    : deviceFlow === 'unknown' ? 'remote.oauthUnverified' : undefined
  const methodsBusy = busy || login !== undefined
  const cachedOAuth = capability.authSelection?.oauthCached === true
  const cliAvailable = capability.authSelection?.cliAvailable !== false
  const cliSource = gitlab ? 'glab' : 'gh'
  const feedback = login === undefined && loginStatus !== undefined && loginStatus !== 'requesting' ? loginStatus : undefined
  const feedbackError = feedback === 'failed' || feedback === 'denied' || feedback === 'expired' || feedback === 'unavailable'
  const source = authenticated && auth.source !== undefined ? sourceLabels[auth.source] : undefined
  let statusLine: string, statusError = feedbackError || auth.state === 'invalid'
  if (login !== undefined) statusLine = t('remote.loginInProgressHint')
  else if (feedback !== undefined) statusLine = t(loginFeedback[feedback])
  else if (authenticated) statusLine = [platformCopy(t, 'remote.authConnectedVia', platform), source === undefined ? undefined : t(source)].filter(item => item !== undefined).join(' · ')
  else {
    const hintKey = hint(auth.state)
    statusLine = hintKey === undefined ? copy(headline(auth.state)) : copy(hintKey)
    statusError = auth.state === 'invalid'
  }
  if (gitlab && instance !== undefined && instance !== 'https://gitlab.com') statusLine = `${instanceHost(instance)} · ${statusLine}`
  const name = authenticated && viewer !== undefined ? `@${viewer.login}` : copy(login !== undefined ? 'remote.loginInProgress' : headline(auth.state))
  const cliDescription = !cliAvailable ? t('remote.cliUnavailable')
    : !authenticated && login === undefined ? t(gitlab ? 'remote.glabLoginHint' : 'remote.ghLoginHint')
    : t('remote.cliDescription').replace('{cli}', cliSource)
  const oauthDescription = login !== undefined ? t('remote.oauthWaiting')
    : oauthHintKey !== undefined ? copy(oauthHintKey)
    : cachedOAuth ? t('remote.oauthSaved')
    : t('remote.oauthDescription')
  const cliDisabled = methodsBusy || !cliAvailable
  const oauthDisabled = methodsBusy || !oauthAvailable
  // During a device login OAuth reads as the active choice: checked border, no dimming, waiting copy.
  const oauthChecked = authenticated && auth.source === 'grant' || login !== undefined
  return (
    <div className={css.authBody}>
      <div className={css.idCard}>
        <AccountAvatar viewer={authenticated ? viewer : undefined} size={32} />
        <div className={css.idText}>
          <span className={css.idName}>{name}</span>
          <span className={`${css.idStatus} ${statusError ? css.idStatusError : ''}`} role="status">{statusLine}</span>
        </div>
        {login === undefined && (cachedOAuth || auth.source === 'grant') && (
          <Button variant="ghost" size="sm" onClick={() => { if (onLogoutOAuth !== undefined) onLogoutOAuth(); else onAuth('remote-sign-out') }}>
            {t('remote.oauthLogout')}
          </Button>
        )}
      </div>
      <div>
        <p className={css.methodsTitle} id={`${group}-label`}>{t('remote.authMethods')}</p>
        <div className={css.authOptions} role="radiogroup" aria-labelledby={`${group}-label`}>
          <label className={`${css.authOption} ${cliDisabled ? css.authOptionDisabled : ''} ${authenticated && auth.source === cliSource ? css.authOptionChecked : ''}`}>
            <input
              type="radio"
              name={group}
              checked={authenticated && auth.source === cliSource}
              disabled={cliDisabled}
              aria-label={t(gitlab ? 'remote.authSourceGlab' : 'remote.authSourceGh')}
              aria-describedby={`${group}-cli-desc`}
              onChange={() => {
                if (cliDisabled) return
                if (capability.authSelection !== undefined && onSelectMethod !== undefined) onSelectMethod('cli')
                else onAuth(...(reset ? ['remote-clear-grant'] : []), 'remote-retry-auth')
              }}
            />
            <span className={css.authOptionText}>
              <span className={css.authOptionTitle}>{t(gitlab ? 'remote.authSourceGlab' : 'remote.authSourceGh')}</span>
              <span id={`${group}-cli-desc`} className={css.authOptionDesc}>{cliDescription}</span>
            </span>
          </label>
          <label className={`${css.authOption} ${oauthDisabled && login === undefined ? css.authOptionDisabled : ''} ${oauthChecked ? css.authOptionChecked : ''}`}>
            <input
              type="radio"
              name={group}
              checked={oauthChecked}
              disabled={oauthDisabled}
              aria-label={copy('remote.authSourceOAuth')}
              aria-describedby={`${group}-oauth-desc`}
              onChange={() => {
                if (oauthDisabled) return
                if (capability.authSelection !== undefined && onSelectMethod !== undefined) onSelectMethod('oauth')
                else onLogin()
              }}
            />
            <span className={css.authOptionText}>
              <span className={css.authOptionTitle}>{copy('remote.authSourceOAuth')}</span>
              <span id={`${group}-oauth-desc`} className={css.authOptionDesc}>{oauthDescription}</span>
              {login !== undefined && (
                <RemoteLoginCard login={login} browser={loginBrowser} copied={loginCopy} onCopy={onCopyLogin} onOpen={onOpenLogin} onCancel={() => { onCancelLogin(login.attemptId) }} t={copy} />
              )}
            </span>
          </label>
        </div>
      </div>
      {gitlab && (
        <div className={css.authNotes}>
          <p>{t('gitlab.authHint')}</p>
          <p>{t('gitlab.noticeLimit')}</p>
        </div>
      )}
    </div>
  )
}
