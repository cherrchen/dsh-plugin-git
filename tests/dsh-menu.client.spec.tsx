// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { AnchoredMenu, dshMenuAnchorProps, dshMenuAnchorSupport } from '../src/compat/dsh-menu.tsx'

/** One trigger rectangle in the client viewport coordinate space. */
function rectOf(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  }
}

/** Nearest ancestor the installed host positioned with inline coordinates (the portal list). */
function placedAncestor(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    if (node.style.left !== '') return node
  }
  return null
}

describe('dshMenuAnchorSupport', () => {
  it('follows the removed callback instead of the copied prop name', () => {
    const measures = function Menu({ getAnchorRect }: { getAnchorRect?: () => DOMRect | null }) {
      return getAnchorRect?.() ?? null
    }
    const anchors = function Menu({ anchorRef }: { anchorRef?: RefObject<HTMLElement | null> }) {
      return anchorRef?.current ?? null
    }
    // 0.2.2-alpha.3 through rc.1 still read the callback while their positioning
    // hook takes an `anchorRef` option, so the newer name alone proves nothing.
    const forwarded = function Menu({ getAnchorRect }: { getAnchorRect?: () => DOMRect | null }) {
      const anchorRef = { current: null }
      return anchorRef.current ?? getAnchorRect?.() ?? null
    }
    expect(dshMenuAnchorSupport(measures)).toBe('rect')
    expect(dshMenuAnchorSupport(forwarded)).toBe('rect')
    expect(dshMenuAnchorSupport(anchors)).toBe('ref')
    expect(dshMenuAnchorSupport(undefined)).toBe('rect')
  })
})

describe('dshMenuAnchorProps', () => {
  it('passes the trigger element where the host anchors with CSS', () => {
    const element: RefObject<HTMLElement | null> = { current: document.createElement('button') }
    expect(dshMenuAnchorProps('ref', element)).toEqual({ anchorRef: element })
  })

  it('reads the live trigger rectangle where the host measures it', () => {
    const trigger = document.createElement('button')
    const attached: { current: HTMLElement | null } = { current: trigger }
    const props = dshMenuAnchorProps('rect', attached)
    const rect = rectOf(300, 120, 40, 20)
    trigger.getBoundingClientRect = () => rect
    expect(props.getAnchorRect?.()).toBe(rect)
    attached.current = null
    expect(props.getAnchorRect?.()).toBeNull()
  })
})

/** Open one anchored menu from a trigger rendered inside the Menu wrapper. */
function Harness(): ReactNode {
  const chevron = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return (
    <AnchoredMenu
      open={open}
      portal
      align="start"
      side="bottom"
      items={[{ id: 'amend', label: 'Amend' }]}
      onSelect={() => { setOpen(false) }}
      onClose={() => { setOpen(false) }}
      anchorRef={chevron}
      anchor={(
        <button ref={chevron} type="button" onClick={() => { setOpen(current => !current) }}>
          Options
        </button>
      )}
    />
  )
}

describe('AnchoredMenu', () => {
  afterEach(() => { cleanup() })

  it('positions the portal list from the supplied trigger on the installed host', () => {
    render(<Harness />)
    const chevron = screen.getByRole('button', { name: 'Options' })
    chevron.getBoundingClientRect = () => rectOf(300, 120, 40, 20)
    fireEvent.click(chevron)
    const item = screen.getByRole('menuitem', { name: 'Amend' })
    // A CSS-anchoring host publishes the trigger under an anchor name; older
    // hosts place the portal list from the rectangle the compat layer supplies.
    const anchorName = chevron.style.getPropertyValue('anchor-name')
    if (anchorName !== '') {
      expect(anchorName).toMatch(/^--dsh-menu-trigger-/u)
    } else {
      const placed = placedAncestor(item)
      expect(placed).not.toBeNull()
      expect(placed?.style.left).toBe('300px')
      expect(placed?.style.top).toBe('144px')
    }
  })
})
