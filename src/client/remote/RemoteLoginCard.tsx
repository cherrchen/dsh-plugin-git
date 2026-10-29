import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitLocaleKey } from '../locales.ts'
import type { RemoteLoginAttempt } from './remote-view.ts'
import css from '../GitRemoteSurface.module.css'

export function RemoteLoginCard({ login, browser, copied, onCopy, onOpen, onCancel, t }: {
  readonly login: RemoteLoginAttempt
  readonly browser?: 'opening' | 'opened' | 'manual' | 'failed' | undefined
  readonly copied?: 'copied' | 'failed' | undefined
  readonly onCopy?: (() => void) | undefined
  /** True means the native opener handled the click; false keeps the portable link. */
  readonly onOpen?: (() => boolean) | undefined
  readonly onCancel: () => void
  readonly t: (key: GitLocaleKey) => string
}): ReactNode {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    setNow(Date.now())
    if (login.expiresAt === undefined) return
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => clearInterval(timer)
  }, [login.attemptId, login.expiresAt])
  const seconds = login.expiresAt === undefined ? undefined : Math.max(0, Math.ceil((login.expiresAt - now) / 1000))
  const expired = seconds === 0
  const browserCopy: GitLocaleKey = browser === 'opening' ? 'remote.loginOpening' : browser === 'opened' ? 'remote.loginBrowserOpened' : browser === 'failed' ? 'remote.loginBrowserFailed' : 'remote.loginBrowserManual'
  return <div className={css.loginCard} role="status">
    <span className={css.methodHint}>{t(login.verificationUriComplete === undefined ? 'remote.loginCodeHint' : 'remote.loginConfirmCodeHint')}</span>
    <span className={css.loginCode}>{login.userCode}</span>
    {seconds !== undefined && <span className={css.methodHint} aria-live="off">{t('remote.loginExpires').replace('{seconds}', String(seconds))}</span>}
    <span className={css.methodHint}>{t(browserCopy)}</span>
    <div className={css.loginActions}>
      {onCopy !== undefined && <Button variant="ghost" size="sm" disabled={expired} onClick={onCopy}>{t('remote.loginCopy')}</Button>}
      <a className={css.loginLink} href={login.verificationUriComplete ?? login.verificationUri} target="_blank" rel="noreferrer" aria-disabled={expired || undefined} onClick={event => {
        if (expired || onOpen?.() === true) event.preventDefault()
      }}>{t(login.verificationUriComplete === undefined ? 'remote.verify' : 'remote.loginContinue')}</a>
      <Button variant="ghost" size="sm" onClick={onCancel}>{t('branch.cancel')}</Button>
    </div>
    {copied !== undefined && <span className={css.methodHint}>{t(copied === 'copied' ? 'remote.loginCopied' : 'remote.loginCopyFailed')}</span>}
  </div>
}
