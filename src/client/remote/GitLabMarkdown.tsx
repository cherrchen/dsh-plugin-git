/** A deliberately small, browser-safe Markdown projection for GitLab content. */
import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfm } from 'micromark-extension-gfm'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gitLabWebUrl } from '../../remote/gitlab-model.ts'
import css from '../GitRemoteSurface.module.css'

type Node = { type: string; value?: string; url?: string; alt?: string; identifier?: string; depth?: number; ordered?: boolean; start?: number | null; children?: readonly Node[]; position?: { start: { offset?: number }; end: { offset?: number } } }
const identifier = (value: string) => value.toLowerCase().replace(/\s+/gu, ' ').trim()
function safeLink(instance: string, raw: string | undefined): string | undefined {
  if (raw === undefined || /[\x00-\x20\x7f\\]/u.test(raw)) return undefined
  try { return gitLabWebUrl(instance, new URL(raw, `${instance}/`).href) } catch { return undefined }
}
function parse(text: string): Node {
  return fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as unknown as Node
}
function render(text: string, instance: string, detailsLabel: string, depth = 0): ReactNode {
  if (depth > 12) return text
  const root = parse(text)
  // CommonMark can split one disclosure across multiple HTML and Markdown blocks.
  // Only scan HTML nodes, so tags inside fenced and inline code never become controls.
  const blocks = root.children ?? []
  for (let index = 0; index < blocks.length; index++) {
    const opening = blocks[index], offset = opening?.position?.start.offset
    if (opening?.type !== 'html' || opening.value === undefined || offset === undefined) continue
    const match = /^<details(?:\s+(open))?\s*>\s*<summary\s*>([\s\S]*?)<\/summary\s*>/iu.exec(opening.value)
    if (match === null) continue
    let level = 1
    for (let nextIndex = index; nextIndex < blocks.length; nextIndex++) {
      const candidate = blocks[nextIndex], candidateOffset = candidate?.position?.start.offset
      if (candidate?.type !== 'html' || candidate.value === undefined || candidateOffset === undefined) continue
      const startAt = nextIndex === index ? match[0].length : 0
      const tags = /<details(?:\s+open)?\s*>|<\/details\s*>/giu
      tags.lastIndex = startAt
      for (const tag of candidate.value.matchAll(tags)) {
        level += tag[0].startsWith('</') ? -1 : 1
        if (level !== 0) continue
        const end = candidateOffset + tag.index, after = end + tag[0].length
        return <>{render(text.slice(0, offset), instance, detailsLabel, depth + 1)}<details className={css.mdDetails} open={match[1] !== undefined}>
          <summary className={css.mdSummary}>{match[2]?.trim() ? render(match[2], instance, detailsLabel, depth + 1) : detailsLabel}</summary>
          <div className={css.mdDetailsBody}>{render(text.slice(offset + match[0].length, end), instance, detailsLabel, depth + 1)}</div>
        </details>{render(text.slice(after), instance, detailsLabel, depth + 1)}</>
      }
    }
  }
  const definitions = new Map<string, string>()
  const collect = (node: Node): void => {
    if (node.type === 'definition' && node.identifier !== undefined && node.url !== undefined) definitions.set(identifier(node.identifier), node.url)
    for (const child of node.children ?? []) collect(child)
  }
  collect(root)
  const nodes = (children: readonly Node[] | undefined): ReactNode => (children ?? []).map((node, index) => {
    const childrenValue = nodes(node.children)
    switch (node.type) {
      case 'text': return node.value ?? ''
      case 'paragraph': return <p key={index}>{childrenValue}</p>
      case 'heading': return <p key={index}><strong>{childrenValue}</strong></p>
      case 'strong': return <strong key={index}>{childrenValue}</strong>
      case 'emphasis': return <em key={index}>{childrenValue}</em>
      case 'delete': return <del key={index}>{childrenValue}</del>
      case 'blockquote': return <blockquote key={index}>{childrenValue}</blockquote>
      case 'inlineCode': return <code key={index}>{node.value}</code>
      case 'code': return <pre key={index}><code>{node.value}</code></pre>
      case 'break': return <br key={index} />
      case 'thematicBreak': return <hr key={index} />
      case 'list': return node.ordered ? <ol key={index} start={node.start ?? undefined}>{childrenValue}</ol> : <ul key={index}>{childrenValue}</ul>
      case 'listItem': return <li key={index}>{childrenValue}</li>
      case 'table': return <table key={index}><tbody>{childrenValue}</tbody></table>
      case 'tableRow': return <tr key={index}>{childrenValue}</tr>
      case 'tableCell': return <td key={index}>{childrenValue}</td>
      case 'image': case 'imageReference': return <span key={index}>{node.alt ?? ''}</span>
      case 'link': case 'linkReference': {
        const raw = node.type === 'link' ? node.url : definitions.get(identifier(node.identifier ?? ''))
        const href = safeLink(instance, raw)
        return href === undefined ? <span key={index}>{childrenValue}</span> : <a key={index} href={href} target="_blank" rel="noopener noreferrer">{childrenValue}</a>
      }
      case 'definition': return null
      case 'html': {
        // Only attribute-free disclosure markup is interpreted; all other HTML stays visible text.
        const disclosure = /^<details(?:\s+(open))?\s*>\s*<summary\s*>([\s\S]*?)<\/summary\s*>([\s\S]*?)<\/details\s*>\s*$/iu.exec(node.value ?? '')
        if (disclosure === null) return <span key={index} style={{ whiteSpace: 'pre-wrap' }}>{node.value}</span>
        return <details key={index} className={css.mdDetails} open={disclosure[1] !== undefined}>
          <summary className={css.mdSummary}>{disclosure[2]?.trim() ? render(disclosure[2], instance, detailsLabel, depth + 1) : detailsLabel}</summary>
          <div className={css.mdDetailsBody}>{render(disclosure[3] ?? '', instance, detailsLabel, depth + 1)}</div>
        </details>
      }
      default: return <span key={index}>{childrenValue}{node.value ?? ''}</span>
    }
  })
  return nodes(root.children)
}
export function GitLabMarkdown({ text, instance, detailsLabel }: { readonly text: string; readonly instance: string; readonly detailsLabel: string }): ReactNode {
  return useMemo(() => render(text, instance, detailsLabel), [text, instance, detailsLabel])
}
