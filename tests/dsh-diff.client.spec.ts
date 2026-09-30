// @vitest-environment jsdom
import { diffTotals } from '@deepseek-ai/dsh-client-ui-primitives'
import { describe, expect, it } from 'vitest'
import { dshDiffLabels, dshDiffSupportsContext } from '../src/compat/dsh-diff.ts'
import { gitFileComparison } from '../src/client/git-diff-adapter.ts'
import { en, zh } from '../src/client/locales.ts'

describe('Official DSH diff compatibility', () => {
  it('keeps unchanged context out of edit totals on the installed host', () => {
    const patch = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,3 +1,3 @@\n shared\n-old\n+new\n tail\n'
    const comparison = gitFileComparison('a', patch, dshDiffSupportsContext)
    expect(comparison.kind).toBe('text')
    if (comparison.kind !== 'text') throw new Error('Expected file fragments')
    expect(diffTotals(comparison.diffs)).toEqual({ added: 1, removed: 1 })
  })

  it.each([en, zh])('supplies localized legacy and current toolbar copy', dictionary => {
    const labels = dshDiffLabels(key => dictionary[key])
    expect(labels.copy).toBe(dictionary['diff.copy'])
    expect(labels.codeLabel).toBe(dictionary['diff.code'])
    expect(labels.wrapLabel).toBe(dictionary['diff.wrap'])
    expect(labels.unwrapLabel).toBe(dictionary['diff.unwrap'])
    expect(labels.expand(7)).toBe(dictionary['diff.expand'].replace('{count}', '7'))
    expect(labels.expandAria(7)).toBe(dictionary['diff.expandAria'].replace('{count}', '7'))
    expect(labels.files(2)).toBe(dictionary['diff.files'].replace('{count}', '2'))
  })
})
