import { useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { canonicalGitLabInstance } from '../../remote/instance-url.ts'
import { ScopedProtocolError } from '../remote-protocol.ts'
import { IconUserOutline16 } from '../../compat/dsh-icons.tsx'
import { GitIconButton } from '../details/GitIconButton.tsx'
import { RemoteAuthSection } from './RemoteAuthSection.tsx'
import { RemoteLoading } from './RemoteLoading.tsx'
import css from '../GitRemoteSurface.module.css'
import type { GitRemoteController } from '../remote.ts'
import type { GitRemoteCapabilityOn, ScopedRemoteCapabilityOn } from '../../remote/types.ts'
import type { GitRemoteViewer } from '../../remote/types.ts'
import type { GitLocaleKey } from '../locales.ts'
import type { RemoteLoginStatus } from './remote-view.ts'

const loginFeedback: Record<RemoteLoginStatus, GitLocaleKey> = {
  requesting: 'remote.loadingAuth', waiting: 'remote.waitingAuth', verifying: 'remote.loginVerifying',
  connected: 'remote.loginConnected', cancelled: 'remote.loginCancelled', expired: 'remote.loginExpired',
  denied: 'remote.loginDenied', failed: 'remote.loginFailed', unavailable: 'remote.loginUnavailable',
}

/** Toolbar entry to the platform-authentication dialog; the controller owns the login-attempt state. */
export function RemoteAuthControl({ capability, viewer, busy, gitlab = false, controller, t }: {
  readonly capability: GitRemoteCapabilityOn | ScopedRemoteCapabilityOn
  readonly viewer: GitRemoteViewer | undefined
  readonly busy: boolean
  /** Scoped GitLab target: labels and retry semantics follow the instance. */
  readonly gitlab?: boolean
  readonly controller: GitRemoteController
  readonly t: (key: GitLocaleKey) => string
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [retireInput, setRetireInput] = useState('')
  const [retireScope, setRetireScope] = useState<string>()
  const [retireResult, setRetireResult] = useState<GitLocaleKey>()
  const [retiring, setRetiring] = useState(false)
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  return (
    <>
      <GitIconButton label={t('remote.auth')} onClick={() => { setOpen(true); if (gitlab) void controller.ensureAuthCapability() }}>
        <IconUserOutline16 size={14} />
      </GitIconButton>
      <Modal
        open={open}
        onClose={() => { setOpen(false) }}
        title={t('remote.auth')}
        closeLabel={t('branch.cancel')}
        className={`${css.authDialog}`}
      >
        <RemoteLoading pending={state.login === undefined ? state.pending : 'authorization'} provider={gitlab ? 'gitlab' : 'github'} t={t} />
        {state.error !== undefined && <p className={css.error} role="alert">{state.error}</p>}
        {state.login === undefined && state.loginStatus !== undefined && state.loginStatus !== 'requesting' && <p className={css.note} role="status">{t(loginFeedback[state.loginStatus])}</p>}
        <RemoteAuthSection
          capability={capability}
          viewer={viewer}
          busy={busy || gitlab && state.scopedCapability === undefined}
          login={state.login}
          loginBrowser={state.loginBrowser}
          loginCopy={state.loginCopy}
          onCopyLogin={() => { void controller.copyLoginCode() }}
          onOpenLogin={() => {
            if (!controller.nativeLoginBrowser) return false
            void controller.openLoginBrowser()
            return true
          }}
          gitlab={gitlab}
          onAuth={(...endpoints) => { void controller.authAction(...endpoints) }}
          onLogin={() => { void controller.login() }}
          onSelectMethod={method => { void controller.selectAuthMethod(method) }}
          onLogoutOAuth={() => { void controller.logoutOAuth() }}
          onCancelLogin={() => { void controller.cancelLogin() }}
          t={t}
        />
        {gitlab && <p className={css.note}>{t('gitlab.noticeLimit')}</p>}
        {controller.scopedAvailable && (
          <details className={css.authAdvanced}>
            <summary>{t('remote.advanced')}</summary>
            <section className={css.retireSection} aria-label={t('remote.retireTitle')}>
              <strong>{t('remote.retireTitle')}</strong>
              <p className={css.methodHint}>{t('remote.retireHint')}</p>
              <label className={css.retireInput}>
                <span>{t('remote.retireUrl')}</span>
                <input value={retireInput} disabled={retiring} onChange={event => { setRetireInput(event.target.value); setRetireScope(undefined); setRetireResult(undefined) }} placeholder="https://git.example.com" />
              </label>
              {retireScope === undefined ? (
                <Button variant="ghost" size="sm" disabled={retiring || !retireInput} onClick={() => {
                  try { setRetireScope(canonicalGitLabInstance(retireInput)); setRetireResult(undefined) } catch { setRetireResult('remote.retireInvalid') }
                }}>{t('remote.retirePrepare')}</Button>
              ) : (
                <div>
                  <p>{t('remote.retireConfirmHint')} <strong>{retireScope}</strong></p>
                  <Button variant="ghost" size="sm" disabled={retiring} onClick={() => {
                    setRetiring(true)
                    void controller.retireGrant(retireScope).then(result => {
                      setRetireResult(result.disposition === 'retired' ? 'remote.retireDone' : result.disposition === 'already-retired' ? 'remote.retireAlready' : 'remote.retireAbsent')
                      setRetireScope(undefined)
                    }).catch(error => {
                      setRetireResult(error instanceof ScopedProtocolError && error.reason === 'instance-registered' ? 'remote.retireRegistered' : error instanceof ScopedProtocolError && error.reason === 'record-mismatch' ? 'remote.retireMismatch' : 'remote.retireFailed')
                    }).finally(() => { setRetiring(false) })
                  }}>{t('remote.retireConfirm')}</Button>
                  <Button variant="ghost" size="sm" disabled={retiring} onClick={() => { setRetireScope(undefined) }}>{t('branch.cancel')}</Button>
                </div>
              )}
              {retireResult !== undefined && <p role="status">{t(retireResult)}</p>}
            </section>
          </details>
        )}
      </Modal>
    </>
  )
}
