/** Convert Git's unified patch into the official DiffBlock's file fragments. */
import { parsePatch } from 'diff'
import type { DiffHunk } from '@deepseek-ai/dsh-client-ui-primitives'

/** A comparison the official text renderer can display, or a non-text status. */
export type GitFileComparison =
  | { kind: 'text'; diffs: DiffHunk[]; newlineChanged: boolean }
  | { kind: 'empty' | 'binary' | 'metadata' | 'invalid' }

/**
 * Decode a single-path Git patch without deriving display paths from quoted Git headers.
 * @param path - Literal repository-relative path selected by the user.
 * @param text - Complete colorless unified patch.
 * @param context - Whether the host's DiffBlock understands shared context.
 * @returns File fragments, or a status for empty, binary, metadata-only or incomplete output.
 */
export function gitFileComparison(path: string, text: string, context = true): GitFileComparison {
  if (text === '') return { kind: 'empty' }
  if (!text.startsWith('diff --git ') || !text.endsWith('\n')) return { kind: 'invalid' }
  try {
    const patches = parsePatch(text)
    if (patches.length === 0) return { kind: 'invalid' }
    if (patches.some(patch => patch.isBinary)) return { kind: 'binary' }
    const diffs: DiffHunk[] = []
    let newlineChanged = false
    for (const patch of patches) {
      let oldMissingNewline = false
      let newMissingNewline = false
      for (const hunk of patch.hunks) {
        let oldText = ''
        let newText = ''
        let previous = ''
        const flush = (): void => {
          if (oldText !== '' || newText !== '') diffs.push({ path, oldText, newText })
          oldText = ''
          newText = ''
        }
        for (const line of hunk.lines) {
          const operation = line[0]
          if (operation === '\\') {
            if (previous === '-' || previous === ' ') {
              oldText = oldText.slice(0, -1)
              oldMissingNewline = true
            }
            if (previous === '+' || previous === ' ') {
              newText = newText.slice(0, -1)
              newMissingNewline = true
            }
          } else if (operation === ' ' && !context) {
            flush()
          } else {
            if (operation !== '+') oldText += `${line.slice(1)}\n`
            if (operation !== '-') newText += `${line.slice(1)}\n`
          }
          previous = operation ?? ''
        }
        flush()
      }
      newlineChanged ||= oldMissingNewline !== newMissingNewline
    }
    return diffs.length === 0 ? { kind: 'metadata' } : { kind: 'text', diffs, newlineChanged }
  } catch {
    // The subprocess collector can retain only a tail: never show a partial patch as a clean file.
    return { kind: 'invalid' }
  }
}
