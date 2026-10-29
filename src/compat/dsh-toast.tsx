/**
 * Toast parity across the supported DSH releases.
 *
 * DSH 0.1.7 added `tone` and `actions` to the primitives Toast; the 0.1.5/0.1.6
 * copy destructures only `{ text, icon, anchor, holdMs, onDone }` and silently
 * drops the rest. A dropped `tone` is cosmetic, but a dropped `actions` would
 * hide the only controls that copy error details or acknowledge a blocked
 * write, so those cases render an equivalent floating alert with real buttons
 * instead. The probe follows the component signature, not the version string.
 */
import { Button, Toast as DshToast } from '@deepseek-ai/dsh-client-ui-primitives'
import { Fragment, useEffect, useLayoutEffect, useRef } from 'react'
import type { ComponentType, CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import css from '../client/GitRemoteSurface.module.css'

export interface GitToastAction {
  readonly prefix: string
  readonly label: string
  readonly onClick: () => void
}

interface GitToastProps {
  readonly text: string
  readonly icon?: ReactNode
  readonly tone?: 'success' | undefined
  readonly anchor?: HTMLElement | null | undefined
  readonly holdMs?: number | undefined
  readonly actions?: readonly GitToastAction[] | undefined
  readonly onDone: () => void
}

/** 0.1.7+ Toast destructures `actions`; older copies do not reference it. */
export const dshToastSupportsActions = typeof DshToast === 'function' && /\bactions\b/u.test(String(DshToast))

/** Cast once so either upstream props shape compiles; unclaimed props are ignored at runtime. */
const HostToast = DshToast as ComponentType<GitToastProps>

const FALLBACK_HOLD_MS = 3000

/** Delegates to the host Toast; renders an equivalent floating alert when the host drops `actions`. */
export function Toast({ text, icon, tone, anchor, holdMs, actions, onDone }: GitToastProps): ReactNode {
  const fallback = actions !== undefined && actions.length > 0 && !dshToastSupportsActions
  const hold = holdMs ?? FALLBACK_HOLD_MS
  const latestOnDone = useRef(onDone)
  useLayoutEffect(() => { latestOnDone.current = onDone })
  useEffect(() => {
    if (!fallback || !Number.isFinite(hold)) return
    const timer = setTimeout(() => { latestOnDone.current() }, hold)
    return () => { clearTimeout(timer) }
  }, [fallback, hold])
  if (fallback) {
    const style = Number.isFinite(hold) ? { '--git-toast-hold': `${hold}ms` } as CSSProperties : undefined
    return createPortal(
      <div role="alert" className={`${css.toastFallback} ${Number.isFinite(hold) ? '' : css.toastFallbackPersistent}`} style={style}>
        {icon !== undefined && <span className={css.toastFallbackIcon} aria-hidden>{icon}</span>}
        <span className={css.toastFallbackText}>
          {text}
          {actions.map(action => (
            <Fragment key={action.label}>
              {action.prefix}
              <Button variant="ghost" size="sm" className={css.toastFallbackAction} onClick={action.onClick}>
                {action.label}
              </Button>
            </Fragment>
          ))}
        </span>
      </div>,
      document.body,
    )
  }
  return <HostToast text={text} icon={icon} tone={tone} anchor={anchor} holdMs={holdMs} actions={actions} onDone={onDone} />
}
