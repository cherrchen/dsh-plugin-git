/** Ref-badge specs: decoration classification, HEAD folding, and chip order. */
import { describe, expect, it } from 'vitest'
import { classifyRef, refBadges } from '../src/client/ref-badge.ts'

const LOCALS = new Set(['main', 'feat/x'])

describe('classifyRef', () => {
  it('classifies HEAD, tags, local branches, and remote-tracking refs', () => {
    expect(classifyRef('HEAD', LOCALS)).toEqual({ kind: 'head', name: 'HEAD' })
    expect(classifyRef('tag: v1', LOCALS)).toEqual({ kind: 'tag', name: 'v1' })
    expect(classifyRef('feat/x', LOCALS)).toEqual({ kind: 'branch', name: 'feat/x' })
    expect(classifyRef('origin/feat/x', LOCALS)).toEqual({ kind: 'remote', name: 'origin/feat/x' })
    expect(classifyRef('origin/HEAD', LOCALS)).toEqual({ kind: 'remote', name: 'origin/HEAD' })
  })
})

describe('refBadges', () => {
  it('folds an attached HEAD into a single chip named after the branch', () => {
    const badges = refBadges(['HEAD', 'feat/x', 'origin/feat/x'], LOCALS, 'feat/x')
    expect(badges).toEqual([
      { kind: 'head', name: 'feat/x' },
      { kind: 'remote', name: 'origin/feat/x' },
    ])
  })

  it('keeps the literal HEAD name for a detached checkout', () => {
    const badges = refBadges(['HEAD', 'main'], LOCALS, null)
    expect(badges).toEqual([
      { kind: 'head', name: 'HEAD' },
      { kind: 'branch', name: 'main' },
    ])
  })

  it('orders chips head, branches, remotes, tags regardless of git order', () => {
    const badges = refBadges(['tag: v1', 'origin/main', 'main'], LOCALS, 'main')
    expect(badges.map(badge => badge.kind)).toEqual(['branch', 'remote', 'tag'])
  })
})
