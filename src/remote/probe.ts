/** Owner-scoped subprocess probes for `gh` and `git credential fill` — bounded, non-interactive, redacted (ADR-0004 clause 3). */

import { GitRemoteError } from './errors.ts'

interface SpawnSpec {
  argv: readonly string[]
  cwd: string
  env?: Record<string, string | undefined>
  signal?: AbortSignal
  stdio: { stdin: 'ignore' | { readonly data: string }; stdout: { maxBytes: number }; stderr: { maxBytes: number } }
  graceMs: number
}

interface SpawnedProcess {
  stdin?: { write?: (chunk: string) => void; end?: () => void } | undefined
  collected: { stdout?: { readFrom(offset: number): { text: string; nextOffset: number; lossy: boolean } } | undefined; stderr?: { readFrom(offset: number): { text: string; nextOffset: number; lossy: boolean } } | undefined }
  done: Promise<{ exitCode: number | null; signal: string | null }>
  terminate?(): void
  terminateForHostExit?(): void
  waitForExit?(): Promise<boolean>
}

export interface GitRemoteSubprocess {
  resolveExecutable(command: string, env?: Record<string, string>, signal?: AbortSignal): Promise<string>
  spawn(spec: SpawnSpec): SpawnedProcess
}

export interface GitRemoteProbeDeps {
  subprocess: GitRemoteSubprocess
  probeTimeoutMs: number
  cwd?: string
}

const HELPER_ENV: Record<string, string> = {
  GIT_ASKPASS: '',
  GIT_TERMINAL_PROMPT: '0',
  SSH_ASKPASS_REQUIRE: 'never',
  GCM_INTERACTIVE: 'never',
}
const PROBE_OUTPUT_CAP = 4096

async function run(deps: GitRemoteProbeDeps, spec: { argv: readonly string[]; env?: Record<string, string>; stdin?: string }, signal: AbortSignal): Promise<string> {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (signal.aborted) controller.abort()
  else signal.addEventListener('abort', onAbort, { once: true })
  const deadline = setTimeout(() => controller.abort(), Math.min(5000, deps.probeTimeoutMs))
  const failure = () => new GitRemoteError('git/remote-unavailable', 'git-remote: credential probe failed', { probe: spec.argv[0] })
  let rejectOnAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    if (controller.signal.aborted) reject(failure())
    else {
      rejectOnAbort = () => reject(failure())
      controller.signal.addEventListener('abort', rejectOnAbort, { once: true })
    }
  })
  void aborted.catch(() => {})
  let child: SpawnedProcess | undefined
  let exited = false
  try {
    const executable = await Promise.race([deps.subprocess.resolveExecutable(spec.argv[0] ?? '', undefined, controller.signal), aborted])
    if (controller.signal.aborted) throw failure()
    child = deps.subprocess.spawn({
      argv: [executable, ...spec.argv.slice(1)],
      cwd: deps.cwd ?? '/',
      env: { ...HELPER_ENV, ...spec.env },
      signal: controller.signal,
      stdio: { stdin: spec.stdin === undefined ? 'ignore' : { data: spec.stdin }, stdout: { maxBytes: PROBE_OUTPUT_CAP }, stderr: { maxBytes: PROBE_OUTPUT_CAP } },
      graceMs: 1000,
    })
    const outcome = await Promise.race([child.done, aborted])
    exited = true
    if (child.waitForExit !== undefined) await child.waitForExit()
    const output = child.collected.stdout?.readFrom(0)
    if (output === undefined || output.lossy || output.text.length > PROBE_OUTPUT_CAP) throw failure()
    const stdout = output.text
    if (outcome.exitCode !== 0) throw failure()
    return stdout
  } catch (error) {
    if (error instanceof GitRemoteError) throw error
    throw failure()
  } finally {
    clearTimeout(deadline)
    if (rejectOnAbort !== undefined) controller.signal.removeEventListener('abort', rejectOnAbort)
    signal.removeEventListener('abort', onAbort)
    if (child !== undefined && !exited) {
      child.terminate?.()
      try {
        await (child.waitForExit?.() ?? child.done)
      } catch (drainError) {
        void drainError
      }
    }
  }
}

export async function ghAuthToken(deps: GitRemoteProbeDeps, signal: AbortSignal): Promise<string | undefined> {
  const stdout = await run(deps, { argv: ['gh', 'auth', 'token', '--hostname', 'github.com'] }, signal)
  const token = stdout.trim()
  return token === '' ? undefined : token
}

export async function gitCredentialFill(deps: GitRemoteProbeDeps, signal: AbortSignal): Promise<string | undefined> {
  const stdout = await run(
    deps,
    {
      argv: ['git', '-c', 'credential.interactive=never', 'credential', 'fill'],
      stdin: 'protocol=https\nhost=github.com\n\n',
    },
    signal,
  )
  for (const line of stdout.split('\n')) {
    if (line.startsWith('password=')) return line.slice('password='.length)
  }
  return undefined
}
