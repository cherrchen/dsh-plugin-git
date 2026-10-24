import type { ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitRemoteCapabilityOn, GitRemoteAuthSource, GitRemoteAuthState } from '../../remote/types.ts'
import type { GitRemoteViewer } from '../../remote/types.ts'
import type { GitLocaleKey } from '../locales.ts'
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

function authSourceLabel({ auth }: GitRemoteCapabilityOn): GitLocaleKey {
  if (auth.state === 'anonymous') return 'remote.authSourceAnonymous'
  if (auth.state !== 'authenticated') return 'remote.authSourceNone'
  return (auth.source === undefined ? undefined : sourceLabels[auth.source]) ?? 'remote.authSourceUnknown'
}

/** Authentication status, transport hint, credential actions, and device login. */
export function RemoteAuthSection({ capability, viewer, busy, login, onAuth, onLogin, onCancelLogin, t }: {
  readonly capability: GitRemoteCapabilityOn
  readonly viewer: GitRemoteViewer | undefined
  readonly busy: boolean
  readonly login: RemoteLoginAttempt | undefined
  readonly onAuth: (endpoint: string) => void
  readonly onLogin: () => void
  readonly onCancelLogin: (attemptId: string) => void
  readonly t: (key: GitLocaleKey) => string
}): ReactNode {
  return (
    <section className={css.authSection} aria-label={t('remote.auth')}>
      <div className={css.authRow}>
        <StateDot state={authDot(capability.auth.state)} />
        <span>{t('remote.auth')}: {capability.auth.state}</span>
        {viewer === undefined ? null : <span className={css.authLogin}>· {viewer.login}</span>}
      </div>
      <dl className={css.authChannel}>
        <dt>{t('remote.authChannel')}</dt>
        <dd>{t(authSourceLabel(capability))}</dd>
      </dl>
      <p className={css.note}>{t('remote.transportHint')}</p>
      <div className={css.authActions}>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => { onAuth('remote-retry-auth') }}>
          {t('remote.retry')}
        </Button>
        {capability.loginAvailable && (
          <Button variant="outline" size="sm" disabled={busy} onClick={onLogin}>
            {t('remote.login')}
          </Button>
        )}
        <Button variant="outline" size="sm" disabled={busy} onClick={() => { onAuth('remote-use-git-credential') }}>
          {t('remote.useGitCredential')}
        </Button>
        <Button variant="outline" size="sm" onClick={() => { onAuth('remote-sign-out') }}>
          {t('remote.signOut')}
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => { onAuth('remote-clear-grant') }}>
          {t('remote.clearGrant')}
        </Button>
      </div>
      {login === undefined ? null : (
        <div className={css.loginCard} role="status">
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
    </section>
  )
}
