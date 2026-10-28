import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CREDENTIALS_SEAM_DSH_RELEASES, SUPPORTED_DSH_RELEASES } from '../src/compat/dsh-version.ts'

const packageRoot = resolve(import.meta.dirname, '..')

describe('Git client bundle', () => {
  it('uses the host-owned DiffBlock without bundling a private renderer', () => {
    const client = readFileSync(join(packageRoot, 'lib/client.js'), 'utf8')
    expect(client).toMatch(/\.DiffBlock\b/)
    expect(client).not.toMatch(/function (DiffBlock|DiffLine)\b/)
    expect(client).not.toContain('diffPlain')
    expect(client).not.toContain('diffAdd')
    expect(client).not.toContain('diffDel')
  })

  it('erases the sidebar type-only import from the client artifact', () => {
    const client = readFileSync(join(packageRoot, 'lib/client.js'), 'utf8')
    expect(client).not.toContain('@dsh-electron/dsh-client-ui-details-host')
    expect(client).not.toContain('require("@deepseek-ai/dsh-client-ui-sidebar-right')
    expect(client).not.toContain('ShellDetailsService')
    expect(client).not.toMatch(/\bDetailsHeaderAction\b/)
  })

  it('keeps the optional credentials package and Node APIs out of the portable loading paths', () => {
    const host = readFileSync(join(packageRoot, 'lib/index.js'), 'utf8')
    const client = readFileSync(join(packageRoot, 'lib/client.js'), 'utf8')
    expect(host).not.toContain('@deepseek-ai/dsh-credentials')
    expect(client).not.toContain('@deepseek-ai/dsh-credentials')
    expect(client).not.toMatch(/require\(["'](?:node:crypto|node:buffer|electron)["']\)/)
  })

  it('compiles an existing GitHub v1 type consumer against the published types entry', () => {
    expect(() => execFileSync(process.execPath, [join(packageRoot, 'node_modules/typescript/bin/tsc'), '--ignoreConfig', '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2024', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', join(packageRoot, 'tests/fixtures/legacy-remote-types.ts')], { cwd: packageRoot, stdio: 'pipe' })).not.toThrow()
  })

  it('ships no module-table requests', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      dsh?: { client?: { external?: string[] } }
    }
    expect(manifest.dsh?.client?.external).toBeUndefined()
  })

  it('admits only the documented DSH releases for every DSH peer', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      peerDependencies: Record<string, string>
    }
    const dshPeers = Object.entries(manifest.peerDependencies)
      .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
    expect(dshPeers.length).toBeGreaterThan(0)
    for (const [name, range] of dshPeers) {
      const expected = name === '@deepseek-ai/dsh-credentials'
        ? CREDENTIALS_SEAM_DSH_RELEASES.join(' || ')
        : SUPPORTED_DSH_RELEASES.join(' || ')
      expect(range).toBe(expected)
    }
  })
})
