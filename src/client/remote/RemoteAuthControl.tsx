import { useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconUserOutline16 } from '../../compat/dsh-icons.tsx'
import { GitIconButton } from '../details/GitIconButton.tsx'
import { RemoteAuthSection, type RemoteLoginAttempt } from './RemoteAuthSection.tsx'
import { RemoteLoading } from './RemoteLoading.tsx'
import css from '../GitRemoteSurface.module.css'
import type { GitRemoteController } from '../remote.ts'
import type { GitRemoteCapabilityOn } from '../../remote/types.ts'
import type { GitRemoteViewer } from '../../remote/types.ts'
import type { GitLocaleKey } from '../locales.ts'

/** Toolbar entry to the platform-authentication dialog; owns the login-attempt state. */
export function RemoteAuthControl({ capability, viewer, busy, controller, t }: {
  readonly capability: GitRemoteCapabilityOn
  readonly viewer: GitRemoteViewer | undefined
  readonly busy: boolean
  readonly controller: GitRemoteController
  readonly t: (key: GitLocaleKey) => string
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [login, setLogin] = useState<RemoteLoginAttempt>()
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  return (
    <>
      <GitIconButton label={t('remote.auth')} onClick={() => { setOpen(true) }}>
        <IconUserOutline16 size={14} />
      </GitIconButton>
      <Modal
        open={open}
        onClose={() => { setOpen(false) }}
        title={t('remote.auth')}
        closeLabel={t('branch.cancel')}
      >
        <RemoteLoading pending={state.pending} t={t} />
        {state.error !== undefined && <p className={css.error} role="alert">{state.error}</p>}
        <RemoteAuthSection
          capability={capability}
          viewer={viewer}
          busy={busy}
          login={login}
          onAuth={endpoint => { void controller.authAction(endpoint) }}
          onLogin={() => { void controller.login(setLogin).finally(() => { setLogin(undefined) }) }}
          onCancelLogin={attemptId => { void controller.cancelLogin(attemptId).finally(() => { setLogin(undefined) }) }}
          t={t}
        />
      </Modal>
    </>
  )
}
