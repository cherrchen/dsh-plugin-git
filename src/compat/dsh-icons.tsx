/** Bridge the fixed-size icon names used before DSH 0.1.7 to weighted glyphs. */
import * as Primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { createElement } from 'react'
import type { ComponentType, SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }
type IconComponent = ComponentType<IconProps>

const iconExports = Primitives as unknown as Record<string, IconComponent | undefined>

/** Resolve the legacy export when present, falling back to the DSH 0.1.7 medium glyph. */
function compatibleIcon(legacyName: string, currentName: string): IconComponent {
  const Icon = iconExports[legacyName] ?? iconExports[currentName]
  if (Icon === undefined) throw new Error(`Missing DSH icon export: ${legacyName} / ${currentName}`)
  return (props) => createElement(Icon, props)
}

export const IconBranchOutline16 = compatibleIcon('IconBranchOutline16', 'IconBranchOutlineMedium')
export const IconCheckOutline16 = compatibleIcon('IconCheckOutline16', 'IconCheckOutlineMedium')
export const IconChevronDownOutline14 = compatibleIcon('IconChevronDownOutline14', 'IconChevronDownOutlineMedium')
export const IconFolderOpenOutline16 = compatibleIcon('IconFolderOpenOutline16', 'IconFolderOpenOutlineMedium')
export const IconRefreshOutline16 = compatibleIcon('IconRefreshOutline16', 'IconRefreshOutlineMedium')
