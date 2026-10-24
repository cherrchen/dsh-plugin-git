import { useId } from 'react'
import type { ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitRemoteCapabilityOn, GitRemoteAuthSource, GitRemoteAuthState } from '../../remote/types.ts'
import type { GitRemoteViewer } from '../../remote/types.ts'
import type { GitLocaleKey } from '../locales.ts'
import { RemoteAvatar } from './RemoteAvatar.tsx'
import css from '../GitRemoteSurface.module.css'

/** Pending device-flow attempt shown until the poll settles or the user cancels. */
export interface RemoteLoginAttempt {
  readonly userCode: string
  readonly verificationUri: string
  readonly attemptId: string
}

function authDot(state: GitRemoteAuthState): 'done' | 'warning' | 'error' | 'idle' {
  if (state === 'authenticated') return 'done'
  if (state === 'invalid') return 'error'
  if (state === 'unauthenticated') return 'warning'
  return 'idle'
}

const sourceLabels: Record<GitRemoteAuthSource, GitLocaleKey> = {
  grant: 'remote.authSourceOAuth',
  ref: 'remote.authSourceRef',
  gh: 'remote.authSourceGh',
  'git-credential': 'remote.authSourceGitCredential',
}

function statusCopy(state: GitRemoteAuthState): { readonly headline: GitLocaleKey; readonly hint?: GitLocaleKey } {
  if (state === 'authenticated') return { headline: 'remote.authStatusConnected' }
  if (state === 'signed-out') return { headline: 'remote.authStatusSignedOut', hint: 'remote.authStatusSignedOutHint' }
  if (state === 'invalid') return { headline: 'remote.authStatusInvalid', hint: 'remote.authStatusInvalidHint' }
  return { headline: 'remote.authStatusAnonymous', hint: 'remote.authStatusAnonymousHint' }
}

/** Authentication status card plus a radio choice of connect methods; checked state derives from capability only. */
export function RemoteAuthSection({ capability, viewer, busy, login, onAuth, onLogin, onCancelLogin, t }: {
  readonly capability: GitRemoteCapabilityOn
  readonly viewer: GitRemoteViewer | undefined
  readonly busy: boolean
  readonly login: RemoteLoginAttempt | undefined
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
  const source = authenticated && auth.source !== undefined ? sourceLabels[auth.source] ?? 'remote.authSourceUnknown' : 'remote.authSourceUnknown'
  const subline = authenticated && auth.source !== 'gh' && auth.source !== 'grant' ? source : undefined
  return (
    <section className={css.authSection} aria-label={t('remote.auth')}>
      <div className={css.authCard}>
        <div className={css.authStatus}>
          <div className={css.authIdentity}>
            {authenticated && viewer !== undefined
              ? <RemoteAvatar login={viewer.login} url={viewer.avatarUrl} size={32} />
              : <StateDot state={authDot(auth.state)} />}
            <div className={css.authIdentityText}>
              <strong>{t(status.headline)}</strong>
              {authenticated && viewer !== undefined && <span className={css.authLogin}>@{viewer.login}</span>}
              {status.hint !== undefined && <span className={css.methodHint}>{t(status.hint)}</span>}
              {subline !== undefined && <span className={css.methodHint}>{t(subline)}</span>}
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
            checked={authenticated && auth.source === 'gh'}
            disabled={busy}
            onChange={() => { onAuth(...(reset ? ['remote-clear-grant'] : []), 'remote-retry-auth') }}
          />
          <span>{t('remote.authSourceGh')}</span>
        </label>
        {!authenticated && <span className={css.radioHint}>{t('remote.ghLoginHint')}</span>}
        {capability.loginAvailable && (
          <label className={css.radioRow}>
            <input
              type="radio"
              name={group}
              checked={authenticated && auth.source === 'grant'}
              disabled={busy}
              onChange={onLogin}
            />
            <span>{t('remote.authSourceOAuth')}</span>
          </label>
        )}
        {capability.loginAvailable && login !== undefined && (
          <div className={css.loginCard} role="status">
            <span className={css.methodHint}>{t('remote.loginCodeHint')}</span>
            <span className={css.loginCode}>{login.userCode}</span>
            <div className={css.loginActions}>
              <a className={css.loginLink} href={login.verificationUri} target="_blank" rel="noreferrer">
                {t('remote.verify')}
              </a>
              <Button variant="ghost" size="sm" onClick={() => { onCancelLogin(login.attemptId) }}>
                {t('branch.cancel')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
