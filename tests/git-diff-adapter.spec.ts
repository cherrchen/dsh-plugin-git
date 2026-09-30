import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gitFileComparison } from '../src/client/git-diff-adapter.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function repository(): { root: string; git: (...args: string[]) => string } {
  const root = mkdtempSync(join(tmpdir(), 'git-official-diff-'))
  roots.push(root)
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  git('init', '-b', 'main')
  git('config', 'user.name', 'Diff Test')
  git('config', 'user.email', 'diff@example.test')
  git('config', 'core.autocrlf', 'false')
  return { root, git }
}

describe('Git patch → official file changes', () => {
  it('keeps staged and worktree content separate and preserves literal Unicode paths', () => {
    const { root, git } = repository()
    const path = '文件 "quoted" name.txt'
    writeFileSync(join(root, path), 'shared\nbefore\ntail\n')
    git('add', '--', path)
    git('commit', '-m', 'initial')
    writeFileSync(join(root, path), 'shared\nstaged\ntail\n')
    git('add', '--', path)
    writeFileSync(join(root, path), 'shared\nworktree\ntail\n')
    const staged = gitFileComparison(path, git('diff', '--cached', '--no-color', '--', path))
    const worktree = gitFileComparison(path, git('diff', '--no-color', '--', path))
    expect(staged).toEqual({ kind: 'text', newlineChanged: false, diffs: [
      { path, oldText: 'shared\nbefore\ntail\n', newText: 'shared\nstaged\ntail\n' },
    ] })
    expect(worktree).toEqual({ kind: 'text', newlineChanged: false, diffs: [
      { path, oldText: 'shared\nstaged\ntail\n', newText: 'shared\nworktree\ntail\n' },
    ] })
    expect(gitFileComparison(path, git('diff', '--cached', '--no-color', '--', path), false)).toEqual({
      kind: 'text', newlineChanged: false, diffs: [{ path, oldText: 'before\n', newText: 'staged\n' }],
    })
  })

  it('converts staged additions, deletions and missing terminal newlines', () => {
    const { root, git } = repository()
    writeFileSync(join(root, 'deleted.txt'), 'removed\n')
    git('add', '.')
    git('commit', '-m', 'initial')
    git('rm', 'deleted.txt')
    writeFileSync(join(root, 'added.txt'), 'added without newline')
    git('add', 'added.txt')
    expect(gitFileComparison('deleted.txt', git('diff', '--cached', '--', 'deleted.txt'))).toEqual({
      kind: 'text', newlineChanged: false, diffs: [{ path: 'deleted.txt', oldText: 'removed\n', newText: '' }],
    })
    expect(gitFileComparison('added.txt', git('diff', '--cached', '--', 'added.txt'))).toEqual({
      kind: 'text', newlineChanged: true, diffs: [{ path: 'added.txt', oldText: '', newText: 'added without newline' }],
    })
  })

  it.each([
    ['both missing', 'before', 'after', false],
    ['both present', 'before\n', 'after\n', false],
    ['newline added', 'same', 'same\n', true],
    ['newline removed', 'same\n', 'same', true],
    ['shared unterminated context', 'before\ntail', 'after\ntail', false],
  ] as const)('compares terminal newline states: %s', (_label, before, after, newlineChanged) => {
    const { root, git } = repository()
    const path = 'newline.txt'
    writeFileSync(join(root, path), before)
    git('add', '--', path)
    git('commit', '-m', 'initial')
    writeFileSync(join(root, path), after)
    const patch = git('diff', '--no-color', '--', path)
    expect(gitFileComparison(path, patch)).toEqual({
      kind: 'text', newlineChanged, diffs: [{ path, oldText: before, newText: after }],
    })
    expect(gitFileComparison(path, patch, false)).toEqual({
      kind: 'text', newlineChanged, diffs: [{
        path,
        oldText: before.replace('tail', ''),
        newText: after.replace('tail', ''),
      }],
    })
  })

  it('recognizes binary and rename-only changes instead of showing a clean file', () => {
    const { root, git } = repository()
    writeFileSync(join(root, 'binary.dat'), Buffer.from([0, 1, 2]))
    writeFileSync(join(root, 'before.txt'), 'same content\n')
    git('add', '.')
    git('commit', '-m', 'initial')
    writeFileSync(join(root, 'binary.dat'), Buffer.from([0, 3, 4]))
    git('mv', 'before.txt', 'after.txt')
    expect(gitFileComparison('binary.dat', git('diff', '--', 'binary.dat'))).toEqual({ kind: 'binary' })
    expect(gitFileComparison('after.txt', git('diff', '--cached'))).toEqual({ kind: 'metadata' })
    expect(gitFileComparison('clean.txt', '')).toEqual({ kind: 'empty' })
  })

  it('keeps separated edit fragments and does not count shared context as edits on legacy hosts', () => {
    const patch = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,5 +1,5 @@\n top\n-old\n+new\n middle\n-last\n+end\n tail\n'
    expect(gitFileComparison('a', patch, false)).toEqual({ kind: 'text', newlineChanged: false, diffs: [
      { path: 'a', oldText: 'old\n', newText: 'new\n' },
      { path: 'a', oldText: 'last\n', newText: 'end\n' },
    ] })
  })

  it('reports newline-only changes even though the official primitive normalizes line terminators', () => {
    const patch = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-same\n\\ No newline at end of file\n+same\n'
    expect(gitFileComparison('a', patch)).toEqual({ kind: 'text', newlineChanged: true, diffs: [
      { path: 'a', oldText: 'same', newText: 'same\n' },
    ] })
  })

  it.each([
    '+tail only\n',
    '@@ -1 +1 @@\n-old\n+new\n',
    'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,2 +1,2 @@\n-old\n+new\n',
    'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new',
  ])('rejects incomplete or headerless output: %s', patch => {
    expect(gitFileComparison('a', patch)).toEqual({ kind: 'invalid' })
  })
})
