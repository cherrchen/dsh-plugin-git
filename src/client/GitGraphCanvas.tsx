/**
 * Git graph rail canvas: draws lanes, edges, and commit nodes for the whole
 * loaded page in ONE continuous coordinate space (see `buildGraphGeometry`),
 * so row boundaries can never break a line. Forks, merges, and compaction
 * shifts are smooth cubic curves; node shapes distinguish normal commits,
 * merges, roots, and HEAD. The canvas is a decorative layer (`aria-hidden`)
 * that scrolls together with the commit rows.
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { GraphLayoutRow } from './graph/types.ts'
import {
  GRAPH_THEME_ATTRIBUTES,
  graphLaneColor,
  resolveGraphColors,
} from './graph/colors.ts'
import {
  GIT_GRAPH_LANE_GAP,
  GIT_GRAPH_NODE_RADIUS,
  GIT_GRAPH_ROW_HEIGHT,
  buildGraphGeometry,
  type GraphNodePoint,
} from './graph-geometry.ts'

/** Rail width for one row's directly connected edges while hovered. */
const HOVER_RAIL_WIDTH = 3

/** Rail width in the resting state. */
const RAIL_WIDTH = 1

/** Render the whole commit page's graph rail as one canvas layer. */
export function GitGraphCanvas({
  rows,
  laneCount,
  hoveredRowIndex,
  className,
}: {
  /** Laid-out graph rows for the loaded pages. */
  rows: readonly GraphLayoutRow[]
  /** Maximum visible lane count across rows. */
  laneCount: number
  /** Row currently hovered; its node and directly connected rails highlight. */
  hoveredRowIndex: number | undefined
  className: string | undefined
}): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [themeEpoch, setThemeEpoch] = useState(0)
  const [devicePixelRatio, setDevicePixelRatio] = useState(() =>
    typeof window === 'undefined' || typeof window.devicePixelRatio !== 'number' ? 1 : window.devicePixelRatio)

  // Redraw when the theme flips: the spine lane resolves a CSS custom
  // property that changes between light and dark.
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return
    const observer = new MutationObserver(() => { setThemeEpoch(epoch => epoch + 1) })
    observer.observe(document.body, GRAPH_THEME_ATTRIBUTES)
    observer.observe(document.documentElement, GRAPH_THEME_ATTRIBUTES)
    return () => { observer.disconnect() }
  }, [])

  // Redraw on DPR changes (window moved across displays).
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onResize = (): void => {
      setDevicePixelRatio(typeof window.devicePixelRatio === 'number' ? window.devicePixelRatio : 1)
    }
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('resize', onResize) }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1
    const geometry = buildGraphGeometry({ rows, laneCount }, { rowHeight: GIT_GRAPH_ROW_HEIGHT, laneGap: GIT_GRAPH_LANE_GAP })
    // The backing store is DPR-scaled while the CSS box stays at design size:
    // without an explicit style size the canvas displays at its attribute
    // size, which is DPR× too large on Retina displays.
    canvas.width = Math.ceil(geometry.width * dpr)
    canvas.height = Math.ceil(geometry.height * dpr)
    canvas.style.width = `${geometry.width}px`
    canvas.style.height = `${geometry.height}px`
    const context = canvas.getContext('2d')
    if (context === null) return
    context.scale(dpr, dpr)
    const colors = resolveGraphColors(canvas)
    context.lineCap = 'round'
    for (const path of geometry.paths) {
      context.beginPath()
      context.strokeStyle = graphLaneColor(path.colorKey, colors.lanes)
      context.lineWidth = path.rowIndex === hoveredRowIndex ? HOVER_RAIL_WIDTH : RAIL_WIDTH
      for (const command of path.commands) {
        if (command.type === 'move') context.moveTo(command.x, command.y)
        else if (command.type === 'line') context.lineTo(command.x, command.y)
        else context.bezierCurveTo(command.cx1, command.cy1, command.cx2, command.cy2, command.x, command.y)
      }
      context.stroke()
    }
    for (const node of geometry.nodes) {
      const color = graphLaneColor(node.colorKey, colors.lanes)
      drawNode(context, node, color, colors.surface, node.rowIndex === hoveredRowIndex)
    }
  }, [rows, laneCount, hoveredRowIndex, themeEpoch, devicePixelRatio])

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />
}

/** Fill one disc at the node's center. */
function fillDisc(context: CanvasRenderingContext2D, x: number, y: number, radius: number, color: string): void {
  context.beginPath()
  context.fillStyle = color
  context.arc(x, y, radius, 0, Math.PI * 2)
  context.fill()
}

/**
 * Draw one commit node the way the VS Code SCM graph does: a lane-colored
 * disc cut out by the surface color underneath, so through-rails read as
 * passing behind the node. HEAD is a hollow ring, merge a thicker ring, and
 * normal/root a solid disc with a surface halo. The hovered row's node grows
 * one pixel of outer radius so the node highlights with its rails.
 */
function drawNode(context: CanvasRenderingContext2D, node: GraphNodePoint, color: string, surface: string, hovered: boolean): void {
  const emphasis = hovered ? 1 : 0
  if (node.isHead) {
    fillDisc(context, node.x, node.y, GIT_GRAPH_NODE_RADIUS + 3 + emphasis, color)
    fillDisc(context, node.x, node.y, GIT_GRAPH_NODE_RADIUS, surface)
    return
  }
  if (node.kind === 'merge') {
    fillDisc(context, node.x, node.y, GIT_GRAPH_NODE_RADIUS + 2 + emphasis, color)
    fillDisc(context, node.x, node.y, GIT_GRAPH_NODE_RADIUS - 1, surface)
    return
  }
  fillDisc(context, node.x, node.y, GIT_GRAPH_NODE_RADIUS + 1 + emphasis, color)
  if (surface === '') return
  context.beginPath()
  context.lineWidth = 2
  context.strokeStyle = surface
  context.arc(node.x, node.y, GIT_GRAPH_NODE_RADIUS + 1 + emphasis, 0, Math.PI * 2)
  context.stroke()
}
