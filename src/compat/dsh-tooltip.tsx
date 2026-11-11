/**
 * Composer tooltips across the supported DSH releases.
 *
 * DSH 0.2.2-alpha.3 makes the docked composer seat a containing block for
 * fixed-position descendants (`will-change: transform`), so a Tooltip bubble
 * kept inside that subtree is placed relative to the seat instead of the
 * viewport. The host contract now requires fixed overlays in the composer to
 * portal to the document body. `portal` exists from 0.1.7-alpha.1; the
 * 0.1.5/0.1.6 copies destructure only their known props and ignore it, so the
 * probe follows the component signature rather than the version string.
 */
import { Tooltip as DshTooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ComponentProps, ComponentType, ReactNode } from 'react'

/** Props the installed host Tooltip accepts, including the oldest shape. */
export type DshTooltipProps = ComponentProps<typeof DshTooltip>

/** 0.1.7+ Tooltip destructures `portal`; older copies never reference it. */
export const dshTooltipSupportsPortal = typeof DshTooltip === 'function' && /\bportal\b/u.test(String(DshTooltip))

/** Cast once so either upstream props shape compiles; older copies drop the extra prop. */
const HostTooltip = DshTooltip as ComponentType<DshTooltipProps & { portal?: boolean }>

/**
 * Tooltip for contributions inside the docked composer.
 * The bubble portals to the document body wherever the host supports it, so a
 * transformed composer cannot drag it away from its anchor.
 * @param props - the host Tooltip props, forwarded unchanged.
 * @returns the anchor with its bubble.
 */
export function ComposerTooltip({ children, ...props }: DshTooltipProps): ReactNode {
  return (
    <HostTooltip {...props} {...(dshTooltipSupportsPortal ? { portal: true } : {})}>
      {children}
    </HostTooltip>
  )
}
