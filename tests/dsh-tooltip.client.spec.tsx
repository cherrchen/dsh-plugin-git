// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ComposerTooltip, dshTooltipSupportsPortal } from '../src/compat/dsh-tooltip.tsx'

/** jsdom has no ResizeObserver; the host Tooltip measures its bubble through one. */
class TestResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element): void {
    const entry = {
      target,
      contentRect: target.getBoundingClientRect(),
      borderBoxSize: [{ inlineSize: 120, blockSize: 20 }],
      contentBoxSize: [{ inlineSize: 120, blockSize: 20 }],
      devicePixelContentBoxSize: [{ inlineSize: 120, blockSize: 20 }],
    } as unknown as ResizeObserverEntry
    this.callback([entry], this as unknown as ResizeObserver)
  }

  unobserve(): void {}
  disconnect(): void {}
}

const originalResizeObserver = globalThis.ResizeObserver

beforeAll(() => {
  globalThis.ResizeObserver ??= TestResizeObserver as unknown as typeof ResizeObserver
})

afterAll(() => {
  if (originalResizeObserver === undefined) delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver
  else globalThis.ResizeObserver = originalResizeObserver
})

describe('ComposerTooltip', () => {
  afterEach(() => { cleanup() })

  it('portals the bubble only where the installed Tooltip supports it', async () => {
    const view = render(
      <div>
        <ComposerTooltip label="Changes" side="top" delayMs={0}>
          <button type="button">1 change</button>
        </ComposerTooltip>
      </div>,
    )
    const anchor = screen.getByRole('button', { name: '1 change' })
    // Hosts before 0.2.2-alpha.2 listen for mouse enter; newer hosts use pointer enter.
    fireEvent.mouseEnter(anchor)
    fireEvent.pointerEnter(anchor, { pointerType: '' })
    const bubble = await screen.findByRole('tooltip')
    expect(bubble.textContent).toContain('Changes')
    if (dshTooltipSupportsPortal) {
      expect(bubble.parentElement).toBe(document.body)
      expect(bubble.getAttribute('data-portal')).toBe('true')
    } else {
      expect(bubble.parentElement).not.toBe(document.body)
      expect(view.container.contains(bubble)).toBe(true)
      expect(bubble.hasAttribute('data-portal')).toBe(false)
    }
  })
})
