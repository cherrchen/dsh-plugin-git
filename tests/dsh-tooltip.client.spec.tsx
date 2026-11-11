// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Tooltip as DshTooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { ComposerTooltip, dshTooltipSupportsPortal } from '../src/compat/dsh-tooltip.tsx'

describe('ComposerTooltip', () => {
  afterEach(() => { cleanup() })

  it('probes the installed Tooltip for portal support', () => {
    expect(dshTooltipSupportsPortal).toBe(/\bportal\b/u.test(String(DshTooltip)))
  })

  it('renders the anchor through either host props shape', () => {
    render(
      <ComposerTooltip label="Changes" side="top" delayMs={200}>
        <button type="button">1 change</button>
      </ComposerTooltip>,
    )
    expect(screen.getByRole('button', { name: '1 change' })).toBeTruthy()
  })
})
