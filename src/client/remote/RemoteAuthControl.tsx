import { useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconUserOutline16 } from '../../compat/dsh-icons.tsx'
import { GitIconButton } from '../details/GitIconButton.tsx'
import { RemoteAuthSection } from './RemoteAuthSection.tsx'
import { RemoteLoading } from './RemoteLoading.tsx'
import { platformCopy } from './platform-copy.ts'
import css from '../GitRemoteSurface.module.css'
import type { GitRemoteController } from '../remote.ts'
import type { GitRemoteCapabilityOn, ScopedRemoteCapabilityOn } from '../../remote/types.ts'
import type { GitRemoteViewer } from '../../remote/types.ts'
import type { GitLocaleKey } from '../locales.ts'

/** Toolbar entry to the platform-authentication dialog; the controller owns the login-attempt state. */
export function RemoteAuthControl({ capability, viewer, busy, gitlab = false, instance, controller, triggerLabel, triggerVariant = 'outline', t }: {
  readonly capability: GitRemoteCapabilityOn | ScopedRemoteCapabilityOn
  readonly viewer: GitRemoteViewer | undefined
  readonly busy: boolean
  /** Scoped GitLab target: labels and retry semantics follow the instance. */
  readonly gitlab?: boolean
  /** Canonical GitLab instance URL; prefixes the status line for self-hosted instances. */
  readonly instance?: string | undefined
  readonly controller: GitRemoteController
  /** Text trigger replaces the toolbar icon button (settings account rows). */
  readonly triggerLabel?: string
  readonly triggerVariant?: 'outline' | 'ghost' | 'primary' | 'toolbar'
  readonly t: (key: GitLocaleKey) => string
}): ReactNode {
  const [open, setOpen] = useState(false)
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const scopedInstance = instance ?? (state.target?.provider === 'gitlab' ? state.target.scope.instance : undefined)
  return (
    <>
      {triggerLabel === undefined
        ? <GitIconButton label={t('remote.auth')} onClick={() => { setOpen(true); if (gitlab) void controller.ensureAuthCapability() }}>
          <IconUserOutline16 size={14} />
        </GitIconButton>
        : <Button variant={triggerVariant} size="sm" disabled={busy} onClick={() => { setOpen(true); if (gitlab) void controller.ensureAuthCapability() }}>{triggerLabel}</Button>}
      <Modal
        open={open}
        onClose={() => { setOpen(false) }}
        title={platformCopy(t, 'remote.authTitle', gitlab ? 'gitlab' : 'github')}
        closeLabel={t('branch.cancel')}
        className={`${css.authDialog}`}
      >
        <RemoteLoading pending={state.login === undefined ? state.pending : 'authorization'} provider={gitlab ? 'gitlab' : 'github'} t={t} />
        {state.error !== undefined && <p className={css.error} role="alert">{state.error}</p>}
        <RemoteAuthSection
          capability={capability}
          viewer={viewer}
          busy={busy || gitlab && state.scopedCapability === undefined}
          login={state.login}
          loginBrowser={state.loginBrowser}
          loginCopy={state.loginCopy}
          loginStatus={state.loginStatus}
          onCopyLogin={() => { void controller.copyLoginCode() }}
          onOpenLogin={() => {
            if (!controller.nativeLoginBrowser) return false
            void controller.openLoginBrowser()
            return true
          }}
          gitlab={gitlab}
          instance={scopedInstance}
          onAuth={(...endpoints) => { void controller.authAction(...endpoints) }}
          onLogin={() => { void controller.login() }}
          onSelectMethod={method => { void controller.selectAuthMethod(method) }}
          onLogoutOAuth={() => { void controller.logoutOAuth() }}
          onCancelLogin={() => { void controller.cancelLogin() }}
          t={t}
        />
      </Modal>
    </>
  )
}
