import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalPath, samePath } from '../src/path-identity.ts'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.restoreAllMocks() })

describe('Windows filesystem identity', () => {
  it('matches short and long path spellings without admitting another checkout', () => {
    const base = process.cwd(), short = resolve(base, 'RUNNER~1'), long = resolve(base, 'runneradmin'), other = resolve(base, 'other')
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    vi.spyOn(realpathSync, 'native').mockImplementation(value => String(value) === short ? long : String(value))
    expect(samePath(short, long, base)).toBe(true)
    expect(samePath(short, other, base)).toBe(false)
  })
  it('keeps missing paths bound to the supplied base when native lookup fails', () => {
    const base = process.cwd()
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    vi.spyOn(realpathSync, 'native').mockImplementation(() => { throw new Error('unreadable') })
    expect(canonicalPath('missing', base)).toBe(resolve(base, 'missing'))
    expect(samePath('missing', 'different', base)).toBe(false)
  })
})
