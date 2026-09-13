/**
 * Repository controls rendered inside each Git frame.
 */
import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { IconFolderOpenOutline16, IconRefreshOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitClientController } from './controller.ts'
import css from './GitDetailsHeaderActions.module.css'

/** Props for the repository controls. */
export type GitDetailsHeaderActionsProps =
  & PropsLocale<'git'>
  & { controller: GitClientController; compact?: boolean }

/**
 * Icon-only header button with the shared tooltip/aria treatment. Local
 * because dynamic plugins may not import runtime values from other packages;
 * this mirrors the DOM contract the host header actions used to render.
 */
function HeaderIcon({ icon, label, disabled, onTrigger }: {
  icon: ReactNode
  label: string
  disabled?: boolean
  onTrigger: () => void
}): ReactNode {
  return (
    <Tooltip label={label} side="top" delayMs={200}>
      <button
        type="button"
        className={css.iconButton}
        aria-label={label}
        disabled={disabled === true}
        onClick={onTrigger}
      >
        {icon}
      </button>
    </Tooltip>
  )
}

/**
 * Render header controls for the Git sidebar tab: icon-only buttons with the
 * shared tooltip/aria treatment. Compact (Changes branch row, Graph scope bar,
 * and Diff top-right overlay) is refresh-only.
 * @param props - locale and shared controller.
 * @returns Reveal (when Desktop is available and not compact) and Refresh.
 */
export function GitDetailsHeaderActions({ controller, t, compact }: GitDetailsHeaderActionsProps): ReactNode {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  return (
    <div className={compact === true ? `${css.root} ${css.compact}` : css.root} data-git-details-header-actions="">
      {compact !== true && state.desktopAvailable && (
        <HeaderIcon
          icon={<IconFolderOpenOutline16 size={14} />}
          label={t('details.reveal')}
          onTrigger={() => { void controller.reveal() }}
        />
      )}
      <HeaderIcon
        icon={<IconRefreshOutline16 size={14} />}
        label={t('details.refresh')}
        onTrigger={() => { void controller.refresh() }}
        disabled={state.loading}
      />
    </div>
  )
}
