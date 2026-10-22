import { describe, expect, it } from 'vitest'
import { ghAuthToken, gitCredentialFill, type GitRemoteSubprocess } from '../src/remote/probe.ts'

interface SpawnRecord {
  argv: string[]
  env?: Record<string, string | undefined>
  stdin?: string
}

function fakeSubprocess(results: { exitCode?: number; stdout?: string } = {}) {
  const spawns: SpawnRecord[] = []
  const subprocess: GitRemoteSubprocess = {
    resolveExecutable: async (command: string) => `/usr/bin/${command}`,
    spawn(spec) {
      spawns.push({ argv: [...spec.argv], env: spec.env, stdin: typeof spec.stdio.stdin === 'object' ? spec.stdio.stdin.data : undefined })
      let offset = 0
      const text = results.stdout ?? ''
      return {
        stdin: typeof spec.stdio.stdin === 'object' ? spec.stdio.stdin.data : undefined === undefined ? undefined : { write: () => {}, end: () => {} },
        collected: {
          stdout: { readFrom: (from: number) => ({ text: text.slice(from), nextOffset: text.length, lossy: false }) },
          stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        },
        done: Promise.resolve({ exitCode: results.exitCode ?? 0, signal: null }),
        terminate: () => {},
        waitForExit: async () => true,
      }
    },
  }
  return { subprocess, spawns }
}

describe('credential subprocess probes', () => {
  it('runs gh auth token with the fixed hostname argv', async () => {
    const { subprocess, spawns } = fakeSubprocess({ stdout: ' tok-value \n' })
    const token = await ghAuthToken({ subprocess, probeTimeoutMs: 5000 }, new AbortController().signal)
    expect(token).toBe('tok-value')
    expect(spawns[0]?.argv).toEqual(['/usr/bin/gh', 'auth', 'token', '--hostname', 'github.com'])
  })

  it('feeds git credential fill the fixed protocol/host pair with non-interactive env', async () => {
    const { subprocess, spawns } = fakeSubprocess({ stdout: 'protocol=https\nhost=github.com\nusername=x\npassword=helper-token\n' })
    const token = await gitCredentialFill({ subprocess, probeTimeoutMs: 5000 }, new AbortController().signal)
    expect(token).toBe('helper-token')
    expect(spawns[0]?.argv).toEqual(['/usr/bin/git', '-c', 'credential.interactive=never', 'credential', 'fill'])
    expect(spawns[0]?.stdin).toBe('protocol=https\nhost=github.com\n\n')
    expect(spawns[0]?.env).toMatchObject({
      GIT_ASKPASS: '',
      GIT_TERMINAL_PROMPT: '0',
      SSH_ASKPASS_REQUIRE: 'never',
      GCM_INTERACTIVE: 'never',
    })
    expect(spawns[0]?.argv.join(' ')).not.toContain('helper-token')
  })

  it('returns undefined when the helper emits no password line', async () => {
    const { subprocess } = fakeSubprocess({ stdout: 'protocol=https\nhost=github.com\n' })
    expect(await gitCredentialFill({ subprocess, probeTimeoutMs: 5000 }, new AbortController().signal)).toBeUndefined()
  })

  it('rejects on non-zero exit without forwarding probe output', async () => {
    const { subprocess } = fakeSubprocess({ exitCode: 1, stdout: 'secret-helper-output' })
    await expect(ghAuthToken({ subprocess, probeTimeoutMs: 5000 }, new AbortController().signal)).rejects.toMatchObject({
      code: 'git/remote-unavailable',
    })
    await expect(ghAuthToken({ subprocess, probeTimeoutMs: 5000 }, new AbortController().signal)).rejects.not.toThrow(/secret-helper-output/u)
  })

  it('propagates a safe failure when the executable cannot be resolved', async () => {
    const subprocess: GitRemoteSubprocess = {
      resolveExecutable: async () => { throw new Error('not found') },
      spawn: () => { throw new Error('unreachable') },
    }
    await expect(ghAuthToken({ subprocess, probeTimeoutMs: 5000 }, new AbortController().signal)).rejects.toMatchObject({
      code: 'git/remote-unavailable',
    })
  })
})
