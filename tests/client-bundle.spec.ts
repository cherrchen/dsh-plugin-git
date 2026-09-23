import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const packageRoot = resolve(import.meta.dirname, '..')

describe('Git client bundle', () => {
  it('erases the sidebar type-only import from the client artifact', () => {
    const client = readFileSync(join(packageRoot, 'lib/client.js'), 'utf8')
    expect(client).not.toContain('@dsh-electron/dsh-client-ui-details-host')
    expect(client).not.toContain('require("@deepseek-ai/dsh-client-ui-sidebar-right')
    expect(client).not.toContain('ShellDetailsService')
    expect(client).not.toMatch(/\bDetailsHeaderAction\b/)
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
    for (const [, range] of dshPeers) {
      expect(range).toBe('0.1.5-rc.2 || 0.1.6-alpha.2 || 0.1.7-alpha.1')
    }
  })
})
