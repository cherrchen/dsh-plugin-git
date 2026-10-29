import { useId } from 'react'
import type { ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitRemoteCapabilityOn, ScopedRemoteCapabilityOn, GitRemoteAuthSource, GitRemoteAuthState } from '../../remote/types.ts'
import type { GitRemoteViewer } from '../../remote/types.ts'
import type { RemoteLoginAttempt } from './remote-view.ts'
import type { GitLocaleKey } from '../locales.ts'
import { RemoteAvatar } from './RemoteAvatar.tsx'
import { platformCopy } from './platform-copy.ts'
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
export function RemoteAuthSection({ capability, viewer, busy, login, gitlab = false, onAuth, onLogin, onCancelLogin, t }: {
  readonly capability: GitRemoteCapabilityOn | ScopedRemoteCapabilityOn
  readonly viewer: GitRemoteViewer | undefined
  readonly busy: boolean
  readonly login: RemoteLoginAttempt | undefined
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
  const status = statusCopy(auth.state)
  const copy = (key: GitLocaleKey): string => platformCopy(t, key, gitlab ? 'gitlab' : 'github')
  const deviceFlow = 'authMethods' in capability ? capability.authMethods.deviceFlow.supported : undefined
  const oauthAvailable = capability.loginAvailable && capability.credential.writable && deviceFlow !== false
  const oauthHint: GitLocaleKey | undefined = deviceFlow === false ? 'remote.oauthUnsupported'
    : !capability.credential.writable ? 'remote.oauthReadOnly'
    : !capability.loginAvailable ? 'remote.oauthNotConfigured'
    : deviceFlow === 'unknown' ? 'remote.oauthUnverified' : undefined
  const methodsBusy = busy || login !== undefined
  const cliSource = gitlab ? 'glab' : 'gh'
  const source = authenticated && auth.source !== undefined
    ? gitlab && auth.source === 'ref' ? 'gitlab.authSourceRef' : sourceLabels[auth.source] ?? 'remote.authSourceUnknown'
    : 'remote.authSourceUnknown'
  const subline = authenticated && auth.source !== cliSource && auth.source !== 'grant' ? source : undefined
  return (
    <section className={css.authSection} aria-label={t('remote.auth')}>
      <div className={css.authCard}>
        <div className={css.authStatus}>
          <div className={css.authIdentity}>
            {authenticated && viewer !== undefined
              ? <RemoteAvatar login={viewer.login} url={viewer.avatarUrl} size={32} />
              : <StateDot state={authDot(auth.state)} />}
            <div className={css.authIdentityText}>
              <strong>{copy(status.headline)}</strong>
              {authenticated && viewer !== undefined && <span className={css.authLogin}>@{viewer.login}</span>}
              {status.hint !== undefined && <span className={css.methodHint}>{copy(status.hint)}</span>}
              {subline !== undefined && <span className={css.methodHint}>{copy(subline)}</span>}
            </div>
          </div>
          {(authenticated || auth.state === 'invalid') && (
            <Button variant="ghost" size="sm" onClick={() => { onAuth('remote-sign-out') }}>
              {t('remote.disconnect')}
            </Button>
          )}
        </div>
      </div>
      <div className={css.authChoices} role="radiogroup" aria-label={t('remote.authMethods')}>
        <span className={css.authMethods}>{t('remote.authMethods')}</span>
        <label className={css.radioRow}>
          <input
            type="radio"
            name={group}
            checked={authenticated && auth.source === cliSource}
            disabled={methodsBusy}
            onChange={() => { if (!methodsBusy) onAuth(...(reset ? ['remote-clear-grant'] : []), 'remote-retry-auth') }}
          />
          <span>{t(gitlab ? 'remote.authSourceGlab' : 'remote.authSourceGh')}</span>
        </label>
        {!authenticated && <span className={css.radioHint}>{t(gitlab ? 'remote.glabLoginHint' : 'remote.ghLoginHint')}</span>}
        <label className={css.radioRow}>
          <input
            type="radio"
            name={group}
            checked={authenticated && auth.source === 'grant'}
            disabled={methodsBusy || !oauthAvailable}
            aria-describedby={oauthHint === undefined ? undefined : `${group}-oauth-hint`}
            onChange={() => { if (!methodsBusy && oauthAvailable) onLogin() }}
          />
          <span>{copy('remote.authSourceOAuth')}</span>
        </label>
        {oauthHint !== undefined && <span id={`${group}-oauth-hint`} className={css.radioHint}>{t(oauthHint)}</span>}
        {login !== undefined && (
          <div className={css.loginCard} role="status">
            <span className={css.methodHint}>{copy('remote.loginCodeHint')}</span>
            <span className={css.loginCode}>{login.userCode}</span>
            <div className={css.loginActions}>
              <a className={css.loginLink} href={login.verificationUri} target="_blank" rel="noreferrer">
                {copy('remote.verify')}
              </a>
              <Button variant="ghost" size="sm" onClick={() => { onCancelLogin(login.attemptId) }}>
                {t('branch.cancel')}
              </Button>
            </div>
          </div>
        )}
      </div>
      {gitlab && <p className={css.note}>{t('gitlab.authHint')}</p>}
    </section>
  )
}
