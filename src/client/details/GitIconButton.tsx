import type { FocusEventHandler, ReactNode } from 'react'
import type { TooltipSide } from '@deepseek-ai/dsh-client-ui-primitives'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import css from '../GitDetailsSurface.module.css'

/** Compact icon button used by Changes rows, section headers, and commit chrome. */
export function GitIconButton({ label, onClick, onBlur, disabled, armed, autoFocus, tooltipSide, children }: {
  label: string
  onClick: () => void
  onBlur?: FocusEventHandler<HTMLButtonElement>
  disabled?: boolean
  /** Two-step confirm: first click arms, second executes. */
  armed?: boolean
  autoFocus?: boolean
  tooltipSide?: TooltipSide | undefined
  children: ReactNode
}): ReactNode {
  return (
    <Tooltip label={label} side={tooltipSide ?? 'top'} delayMs={200}>
      <button
        type="button"
        className={armed === true ? `${css.iconButton} ${css.iconButtonArmed}` : css.iconButton}
        aria-label={label}
        aria-disabled={disabled === true || undefined}
        {...(autoFocus === true ? { autoFocus: true } : {})}
        {...(onBlur === undefined ? {} : { onBlur })}
        {...(disabled === true ? {} : { onClick })}
      >
        {children}
      </button>
    </Tooltip>
  )
}
