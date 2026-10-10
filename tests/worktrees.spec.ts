import { describe, expect, it } from 'vitest'
import { parseWorktreeList } from '../src/worktrees.ts'
import { effectiveWorkspacePath } from '../src/client/workspace-path.ts'

describe('parseWorktreeList', () => {
  it('parses newline and NUL porcelain, including detached and bare records', () => {
    const newline = [
      'worktree /main',
      'HEAD abc',
      'branch refs/heads/main',
      '',
      'worktree /linked',
      'HEAD def',
      'detached',
      '',
      'worktree /bare',
      'bare',
      '',
    ].join('\n')
    expect(parseWorktreeList(newline)).toEqual([
      { path: '/main', head: 'abc', branch: 'main', detached: false, bare: false },
      { path: '/linked', head: 'def', branch: null, detached: true, bare: false },
      { path: '/bare', head: null, branch: null, detached: false, bare: true },
    ])
    const nul = 'worktree /main\0HEAD abc\0branch refs/heads/topic/one\0\0worktree /linked\0HEAD def\0branch refs/heads/feature\0\0'
    expect(parseWorktreeList(nul).map(entry => entry.branch)).toEqual(['topic/one', 'feature'])
  })
})

describe('effectiveWorkspacePath', () => {
  it('maps header cwd and the workingDirectory projection without a second store', () => {
    expect(effectiveWorkspacePath(undefined)).toBeUndefined()
    expect(effectiveWorkspacePath({ cwd: '/repo-a' })).toBe('/repo-a')
    expect(effectiveWorkspacePath({ cwd: '/repo-a', projectionValues: { workingDirectory: '/repo-a/nested' } })).toBe('/repo-a/nested')
    expect(effectiveWorkspacePath({ cwd: '/repo-a', projectionValues: { workingDirectory: '/repo-b' } })).toBe('/repo-b')
    expect(effectiveWorkspacePath({ cwd: '/repo-a', projectionValues: { workingDirectory: '/repo-a-wt' } })).toBe('/repo-a-wt')
    expect(effectiveWorkspacePath({ cwd: '/repo-a', projectionValues: { workingDirectory: null } })).toBe('/repo-a')
    expect(effectiveWorkspacePath({ projectionValues: { workingDirectory: null } })).toBeUndefined()
    const sessionA = effectiveWorkspacePath({ cwd: '/repo', projectionValues: { workingDirectory: '/repo-wt-a' } })
    const sessionB = effectiveWorkspacePath({ cwd: '/repo', projectionValues: { workingDirectory: '/repo-wt-b' } })
    expect(sessionA).toBe('/repo-wt-a')
    expect(sessionB).toBe('/repo-wt-b')
  })
})
