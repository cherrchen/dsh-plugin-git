import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { developmentPin, lockfileDrift, pinDshDependencies } = require('../scripts/dsh-release-wave.cjs')

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
