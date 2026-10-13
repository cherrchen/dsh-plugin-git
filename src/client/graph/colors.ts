/**
 * Lane colors: a lane's color binds to its logical identity (`colorKey`,
 * assigned at lane creation) — never to the visual column — so compaction and
 * pagination never recolor an ancestry.
 */
import type { GraphEdge, GraphLanePlacement, GraphLayoutNode } from './types.ts'

/** Lane palette cycled by color index — the VS Code SCM graph's colorblind-safe set. */
export const GRAPH_LANE_PALETTE = ['#FFB000', '#DC267F', '#994F00', '#40B0A6', '#B66DFF'] as const

/** Surface token behind node cutout rings so lanes read as passing under each node. */
export const GRAPH_SURFACE_TOKEN = '--dsw-alias-bg-base'

/** Attributes whose changes can flip the resolved surface token (light/dark). */
export const GRAPH_THEME_ATTRIBUTES: MutationObserverInit = {
  attributes: true,
  attributeFilter: ['class', 'data-ds-dark-theme', 'data-theme', 'data-color-scheme'],
}

/** Numeric color index encoded in a lane's `colorKey`. */
export function graphColorIndex(colorKey: string): number {
  const parsed = Number.parseInt(colorKey, 10)
  return Number.isNaN(parsed) ? 0 : parsed
}

/** Lane palette plus the resolved surface color used for node cutout rings. */
export interface GraphColors {
  readonly lanes: readonly string[]
  readonly surface: string
}

/** Resolve the lane palette and the theme surface color relative to a rendered element. */
export function resolveGraphColors(element: Element): GraphColors {
  let surface = ''
  if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    surface = window.getComputedStyle(element).getPropertyValue(GRAPH_SURFACE_TOKEN).trim()
  }
  return { lanes: GRAPH_LANE_PALETTE, surface }
}

/** Color of one lane given the resolved palette. */
export function graphLaneColor(colorKey: string, colors: readonly string[]): string {
  return colors.at(graphColorIndex(colorKey) % colors.length) ?? colors[0] ?? ''
}

/** Color of a layout row's node. */
export function graphNodeColor(node: GraphLayoutNode, colors: readonly string[]): string {
  return graphLaneColor(node.colorKey, colors)
}

/** Color of a lane placement (through rail, merging lane, or edge). */
export function graphPlacementColor(placement: GraphLanePlacement | GraphEdge, colors: readonly string[]): string {
  return graphLaneColor(placement.colorKey, colors)
}
