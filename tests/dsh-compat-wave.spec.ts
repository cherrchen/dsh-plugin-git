import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { developmentPin, hostRuntimePins, lockfileDrift, pinDshDependencies } = require('../scripts/dsh-release-wave.cjs')

describe('published host runtime pins', () => {
  it('keeps host companions on their release floors instead of floating across Cordis versions', () => {
    expect(hostRuntimePins([
      { peerDependencies: { '@deepseek-ai/cordis-plugin-include': '^1.0.6' }, dependencies: { '@deepseek-ai/cosmokit': '~1.8.3', unrelated: '^9' } },
      { peerDependencies: { '@deepseek-ai/cordis-plugin-group': '~1.0.6-alpha.1' } },
      { dependencies: { '@deepseek-ai/cordis': '~4.0.6-alpha.1', '@deepseek-ai/cordis-plugin-include': '~1.0.11-alpha.1', '@deepseek-ai/schemastery': '3.18.6-alpha.1', '@deepseek-ai/dsh-settings': '0.2.2-alpha.2' } },
    ])).toEqual({
      '@deepseek-ai/cordis-plugin-include': '1.0.11-alpha.1',
      '@deepseek-ai/cordis-plugin-group': '1.0.6-alpha.1',
      '@deepseek-ai/cosmokit': '1.8.3',
      '@deepseek-ai/cordis': '4.0.6-alpha.1',
      '@deepseek-ai/schemastery': '3.18.6-alpha.1',
    })
  })

  it('rejects ambiguous runtime declarations instead of silently selecting a different host copy', () => {
    expect(() => hostRuntimePins([{ dependencies: { '@deepseek-ai/cordis': '^4.0.2 || ^4.0.6' } }])).toThrow('no single runtime floor')
  })
})

describe('DSH release-wave pin', () => {
  it('rewrites every transitive DSH specifier to the pin', () => {
    const pkg = {
      dependencies: {
        '@deepseek-ai/dsh-win32-process': '^0.1.1-rc.2',
        leftPad: '^1.0.0',
      },
      optionalDependencies: {
        '@deepseek-ai/dsh-brand': '~0.1.5-rc.2',
      },
      peerDependencies: {
        '@deepseek-ai/dsh-session': '^0.1.5-rc.2',
      },
      devDependencies: {
        '@deepseek-ai/dsh-llm': '^0.1.5-rc.2',
      },
    }

    pinDshDependencies(pkg, '0.1.5-rc.2')

    expect(pkg.dependencies['@deepseek-ai/dsh-win32-process']).toBe('0.1.5-rc.2')
    expect(pkg.dependencies.leftPad).toBe('^1.0.0')
    expect(pkg.optionalDependencies['@deepseek-ai/dsh-brand']).toBe('0.1.5-rc.2')
    expect(pkg.peerDependencies['@deepseek-ai/dsh-session']).toBe('0.1.5-rc.2')
    expect(pkg.devDependencies['@deepseek-ai/dsh-llm']).toBe('^0.1.5-rc.2')
  })

  it('leaves the root peer OR range untouched', () => {
    const pkg = {
      peerDependencies: {
        '@deepseek-ai/dsh-settings': '0.1.5-rc.2 || 0.1.6-alpha.1',
      },
    }

    pinDshDependencies(pkg, '0.1.5-rc.2', { skipPeerDependencies: true })

    expect(pkg.peerDependencies['@deepseek-ai/dsh-settings']).toBe('0.1.5-rc.2 || 0.1.6-alpha.1')
  })

  it('reads the single development pin', () => {
    expect(developmentPin({
      devDependencies: {
        '@deepseek-ai/dsh-settings': '0.1.5-rc.2',
        '@deepseek-ai/dsh-subprocess': '0.1.5-rc.2',
        '@deepseek-ai/cordis': '4.0.2',
      },
    })).toBe('0.1.5-rc.2')
  })

  it('rejects a lockfile that resolved another DSH version', () => {
    const lockText = `
packages:

  '@deepseek-ai/dsh-settings@0.1.5-rc.2':
    resolution: {integrity: sha}

  '@deepseek-ai/dsh-brand@0.1.7-alpha.1':
    resolution: {integrity: sha}

snapshots:

  '@deepseek-ai/dsh-settings@0.1.5-rc.2(@deepseek-ai/dsh-brand@0.1.7-alpha.1)':
    dependencies:
      '@deepseek-ai/dsh-brand': 0.1.7-alpha.1
`
    expect(lockfileDrift(lockText, '0.1.5-rc.2')).toEqual([
      '@deepseek-ai/dsh-brand\n    expected: 0.1.5-rc.2\n    resolved: 0.1.7-alpha.1',
    ])
  })
})

describe('optional credentials installation lanes', () => {
  it('omits only the old root development peer edge while preserving the published manifest', () => {
    const { hooks } = require('../.pnpmfile.cjs')
    const before = process.env['DSH_COMPAT_VERSION']
    try {
      process.env['DSH_COMPAT_VERSION'] = '0.1.5-rc.2'
      const pkg = { name: '@dsh-electron/dsh-plugin-git', peerDependencies: { '@deepseek-ai/dsh-credentials': '0.2.0-rc.2 || 0.2.1-rc.2', '@deepseek-ai/dsh-settings': '0.1.5-rc.2 || 0.2.0-rc.2' } }
      hooks.readPackage(pkg)
      expect(pkg.peerDependencies).not.toHaveProperty('@deepseek-ai/dsh-credentials')
      expect(pkg.peerDependencies['@deepseek-ai/dsh-settings']).toBe('0.1.5-rc.2 || 0.2.0-rc.2')
      expect(require('../package.json').peerDependencies).toHaveProperty('@deepseek-ai/dsh-credentials')
      process.env['DSH_COMPAT_VERSION'] = '0.2.0-rc.2'
      const supported = { name: '@dsh-electron/dsh-plugin-git', peerDependencies: { '@deepseek-ai/dsh-credentials': '0.2.0-rc.2 || 0.2.1-rc.2' } }
      hooks.readPackage(supported)
      expect(supported.peerDependencies['@deepseek-ai/dsh-credentials']).toBe('0.2.0-rc.2 || 0.2.1-rc.2')
    } finally { if (before === undefined) delete process.env['DSH_COMPAT_VERSION']; else process.env['DSH_COMPAT_VERSION'] = before }
  })
})
