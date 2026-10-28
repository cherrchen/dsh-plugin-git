/** RPC integration adapter: real child processes without upstream containment probes. */
import { spawn } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, extname, join } from 'node:path'

export function localSubprocess() {
  const reader = (parts: Buffer[]) => ({
    readFrom: (from: number) => {
      const buffer = Buffer.concat(parts).subarray(from)
      return { text: buffer.toString('utf8'), nextOffset: from + buffer.length, lossy: false }
    },
  })
  return {
    resolveExecutable: async (command: string) => {
      const environment = (key: string) => process.env[Object.keys(process.env).find(name => process.platform === 'win32' ? name.toUpperCase() === key : name === key) ?? key]
      const extensions = process.platform === 'win32' && extname(command) === ''
        ? (environment('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';')
        : ['']
      for (const directory of (environment('PATH') ?? '').split(delimiter)) {
        for (const extension of extensions) {
          const candidate = join(directory, command + extension)
          try {
            if (!statSync(candidate).isFile()) continue
            accessSync(candidate, constants.X_OK)
            return candidate
          } catch {}
        }
      }
      throw new Error(`localSubprocess: ${command} was not found on PATH`)
    },
    spawn(spec: { argv: readonly string[]; cwd: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal }) {
      const env = { ...process.env }
      for (const [key, value] of Object.entries(spec.env ?? {})) {
        if (value === undefined) delete env[key]
        else env[key] = value
      }
      const child = spawn(spec.argv[0]!, [...spec.argv.slice(1)], {
        cwd: spec.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(spec.signal !== undefined ? { signal: spec.signal } : {}),
      })
      const stdoutParts: Buffer[] = []
      const stderrParts: Buffer[] = []
      child.stdout?.on('data', (chunk: Buffer) => stdoutParts.push(chunk))
      child.stderr?.on('data', (chunk: Buffer) => stderrParts.push(chunk))
      return {
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
        collected: { stdout: reader(stdoutParts), stderr: reader(stderrParts) },
        done: new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
          child.once('error', reject)
          child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
        }),
        terminate: () => { child.kill('SIGTERM') },
        terminateForHostExit: () => { child.kill('SIGKILL') },
        waitForExit: async () => true,
      }
    },
  }
}
