/** Browser-safe comparison coordinates derived from original unified hunk headers, never rendered line numbers. */
import type { RemoteFile } from './provider.ts'
export interface RemoteDiffAnchor { readonly path: string; readonly commitSha: string; readonly baseSha: string; readonly line: number; readonly side: 'LEFT' | 'RIGHT'; readonly hunk: number }
export interface RemoteDiffLine { readonly text: string; readonly kind: 'context' | 'add' | 'delete' | 'header'; readonly oldLine?: number; readonly newLine?: number; readonly anchor?: RemoteDiffAnchor }
export interface RemoteDiff { readonly lines: readonly RemoteDiffLine[]; readonly safe: boolean; readonly reason?: 'missing-patch' | 'unsupported-change' | 'incomplete-patch' }
export function remoteDiff(file: RemoteFile, baseSha: string, headSha: string): RemoteDiff {
  if (file.patch === undefined) return { lines: [], safe: false, reason: 'missing-patch' }
  const lines: RemoteDiffLine[] = []
  let oldLine = 0; let newLine = 0; let oldRemaining = 0; let newRemaining = 0; let hunk = -1
  let valid = true; let additions = 0; let deletions = 0
  const input = file.patch.split('\n')
  if (input.at(-1) === '') input.pop()
  for (const text of input) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text)
    if (header !== null) {
      if (oldRemaining !== 0 || newRemaining !== 0) valid = false
      oldLine = Number(header[1]); oldRemaining = Number(header[2] ?? 1)
      newLine = Number(header[3]); newRemaining = Number(header[4] ?? 1)
      hunk += 1; lines.push({ text, kind: 'header' }); continue
    }
    if (text.startsWith('\\ No newline')) { lines.push({ text, kind: 'header' }); continue }
    if (hunk < 0 || ![' ', '+', '-'].includes(text[0] ?? '')) { valid = false; lines.push({ text, kind: 'header' }); continue }
    const kind = text[0] === '+' ? 'add' : text[0] === '-' ? 'delete' : 'context'
    const side = kind === 'delete' ? 'LEFT' : 'RIGHT'
    const line = side === 'LEFT' ? oldLine : newLine
    lines.push({ text, kind, ...(kind === 'add' ? {} : { oldLine }), ...(kind === 'delete' ? {} : { newLine }), anchor: { path: file.path, commitSha: headSha, baseSha, line, side, hunk } })
    if (kind !== 'add') { oldLine += 1; oldRemaining -= 1 }
    if (kind !== 'delete') { newLine += 1; newRemaining -= 1 }
    if (kind === 'add') additions += 1
    if (kind === 'delete') deletions += 1
    if (oldRemaining < 0 || newRemaining < 0) valid = false
  }
  valid &&= hunk >= 0 && oldRemaining === 0 && newRemaining === 0 && additions === file.additions && deletions === file.deletions
  const supported = (file.status === 'modified' || file.status === 'added') && file.previousPath === undefined
  const safe = valid && supported
  return { lines: safe ? lines : lines.map(({ anchor: _anchor, ...line }) => line), safe, ...(safe ? {} : { reason: !supported ? 'unsupported-change' as const : 'incomplete-patch' as const }) }
}
export function validRange(start: RemoteDiffAnchor, end: RemoteDiffAnchor): boolean { return start.path === end.path && start.commitSha === end.commitSha && start.baseSha === end.baseSha && start.side === end.side && start.hunk === end.hunk && start.line <= end.line }
