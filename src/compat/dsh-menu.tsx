/**
 * Menus positioned against a trigger the Menu does not render itself.
 *
 * DSH `0.2.2-rc.2` removes `Menu.getAnchorRect` and positions portal menus from
 * the trigger element's CSS anchor (`anchorRef`); earlier copies measure the
 * callback's rectangle. Both inputs describe the same trigger, so the probe
 * asks whether the installed component still reads the removed callback
 * rather than comparing version strings. The copying releases between them
 * name `anchorRef` internally — their positioning hook takes that option —
 * so the newer prop's presence alone does not identify the interface.
 */
import { Menu as DshMenu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ComponentProps, ComponentType, ReactNode, RefObject } from 'react'

/** Props the installed host Menu accepts, including the oldest shape. */
export type DshMenuProps = ComponentProps<typeof DshMenu>

/** How the installed Menu learns the rectangle of a trigger it does not render. */
export type DshMenuAnchorSupport = 'ref' | 'rect'

/** Anchor input of one host: the newer element ref or the older measuring callback. */
export interface DshMenuAnchorProps {
  /** Trigger element, read by 0.2.2-rc.2 and later. */
  anchorRef?: RefObject<HTMLElement | null>
  /** Trigger rectangle, read before 0.2.2-rc.2. */
  getAnchorRect?: () => DOMRect | null
}

/**
 * Which anchor input the installed Menu reads.
 * @param component - Menu exported by the installed primitives host.
 * @returns `rect` while the component still reads the callback, otherwise `ref` for the CSS anchor.
 */
export function dshMenuAnchorSupport(component: unknown): DshMenuAnchorSupport {
  if (typeof component !== 'function') return 'rect'
  return /\bgetAnchorRect\b/u.test(String(component)) ? 'rect' : 'ref'
}

/**
 * Build the anchor input the installed host reads from one trigger element.
 * @param support - host shape from {@link dshMenuAnchorSupport}.
 * @param element - trigger the portal list positions against.
 * @returns props for that host; the callback form reads the live rectangle on every placement.
 */
export function dshMenuAnchorProps(
  support: DshMenuAnchorSupport,
  element: RefObject<HTMLElement | null>,
): DshMenuAnchorProps {
  if (support === 'ref') return { anchorRef: element }
  return { getAnchorRect: () => element.current?.getBoundingClientRect() ?? null }
}

/** Props of {@link AnchoredMenu}: the host Menu plus the optional external trigger. */
export type AnchoredMenuProps = DshMenuProps & {
  /** Element the portal list positions against; omitted, the Menu wrapper is measured. */
  anchorRef?: RefObject<HTMLElement | null> | undefined
}

/** Cast once so either upstream props shape compiles; each host drops the input it does not read. */
const HostMenu = DshMenu as ComponentType<DshMenuProps & DshMenuAnchorProps>

/** Probe once per installed host; a lane's bundle never changes during a session. */
const anchorSupport = dshMenuAnchorSupport(DshMenu)

/**
 * Menu whose portal list follows a trigger supplied as a ref.
 * @param props - host Menu props; `anchorRef` names the external trigger.
 * @returns the host Menu with the anchor input this release reads.
 */
export function AnchoredMenu({ anchorRef, ...props }: AnchoredMenuProps): ReactNode {
  const anchor = anchorRef === undefined ? undefined : dshMenuAnchorProps(anchorSupport, anchorRef)
  return <HostMenu {...props} {...anchor} />
}
