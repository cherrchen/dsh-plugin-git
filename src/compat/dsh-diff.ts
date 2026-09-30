/** Official DiffBlock integration across the supported DSH releases. */
import { diffTotals } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DiffBlockLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitLocaleKey } from '../client/locales.ts'

// 0.1.5 counts both complete fragments as replacements; later versions compare shared context.
const totals = diffTotals([{ path: '', oldText: 'context\n', newText: 'context\n' }])
export const dshDiffSupportsContext = totals.added === 0 && totals.removed === 0

/**
 * Supply both legacy file-count copy and the current code-toolbar labels.
 * @param t - Git namespace translator.
 * @returns Labels accepted by every supported official DiffBlock.
 */
export function dshDiffLabels(t: (key: GitLocaleKey) => string): DiffBlockLabels & { files: (count: number) => string; codeLabel: string; wrapLabel: string; unwrapLabel: string } {
  const counted = (key: GitLocaleKey) => (count: number): string => t(key).replace('{count}', String(count))
  return {
    copy: t('diff.copy'), copied: t('diff.copied'),
    collapse: t('diff.collapse'), collapseAria: t('diff.collapseAria'),
    expand: counted('diff.expand'), expandAria: counted('diff.expandAria'),
    files: counted('diff.files'), codeLabel: t('diff.code'),
    wrapLabel: t('diff.wrap'), unwrapLabel: t('diff.unwrap'),
  }
}
