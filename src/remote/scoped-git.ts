/** Cross-instance remote discovery. Unregistered hosts are never contacted. */
import { parseRemoteUrl, type RemoteGitRun } from './git.ts'
import type { GitLabInstance } from './instances.ts'
import type { ScopedRemoteScope } from './types.ts'
import type { ScopedRemoteRepository } from './provider.ts'

export type ScopedDiscoveredIdentity = ScopedRemoteRepository
export interface ScopedRemoteRepositorySet {
  readonly state: 'supported' | 'no-remotes' | 'unsupported'
  readonly remotes: readonly { name: 'origin' | 'upstream'; identity: ScopedDiscoveredIdentity }[]
  readonly unresolved?: readonly { name: 'origin' | 'upstream'; reason: 'unregistered' | 'ambiguous' }[]
}
function projectPath(path: string): string | undefined {
  if (!path.startsWith('/') || path.includes('//') || /[\\?#\x00-\x20\x7f]/u.test(path)) return undefined
  const raw = path.slice(1).replace(/\/$/, '').split('/')
  if (raw.length < 2) return undefined
  const parts: string[] = []
  for (const segment of raw) {
    let decoded: string
    try { decoded = decodeURIComponent(segment) } catch { return undefined }
    if (!decoded || decoded === '.' || decoded === '..' || /[\\/%\x00-\x20\x7f]/u.test(decoded)) return undefined
    parts.push(decoded)
  }
  const last = parts.at(-1)
  if (last?.endsWith('.git')) parts[parts.length - 1] = last.slice(0, -4)
  if (!parts.at(-1) || parts.at(-1) === '.' || parts.at(-1) === '..') return undefined
  return parts.join('/')
}
export function parseScopedRemote(value: string, instances: readonly GitLabInstance[]): { identity?: ScopedDiscoveredIdentity; reason?: 'unregistered' | 'ambiguous' } {
  const github = parseRemoteUrl(value)
  if (github !== undefined) return { identity: { ...github, scope: { provider: 'github', instance: 'https://github.com' } } }
  if (/[\\\x00-\x20\x7f]/u.test(value)) return { reason: 'unregistered' }
  let candidates: { descriptor: GitLabInstance; path: string }[] = []
  const scp = /^git@([^/:]+):(.+)$/.exec(value)
  if (scp !== null && scp[1] !== undefined && scp[2] !== undefined) {
    let host: string
    try { host = new URL(`https://${scp[1]}`).hostname } catch { return { reason: 'unregistered' } }
    const path = projectPath(`/${scp[2]}`)
    if (path !== undefined) candidates = instances.filter(item => item.sshHost === host && item.sshPort === 22).map(descriptor => ({ descriptor, path }))
  } else {
    const match = /^(https|ssh):\/\/([^/]+)(\/[^?#]*)$/i.exec(value)
    if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) return { reason: 'unregistered' }
    const rawPath = match[3]
    // Reject dangerous input before URL normalizes dot segments.
    if (rawPath.split('/').some(part => { try { const decoded = decodeURIComponent(part); return decoded === '.' || decoded === '..' || /[\\/%]/u.test(decoded) } catch { return true } })) return { reason: 'unregistered' }
    let url: URL
    try { url = new URL(value) } catch { return { reason: 'unregistered' } }
    if (url.search || url.hash || url.password || (url.protocol === 'https:' && url.username) || (url.protocol === 'ssh:' && url.username !== 'git')) return { reason: 'unregistered' }
    if (url.protocol === 'https:') {
      for (const descriptor of instances) {
        const parsed = new URL(descriptor.instance)
        if (url.origin !== parsed.origin || !rawPath.startsWith(`${descriptor.prefix}/`)) continue
        const path = projectPath(rawPath.slice(descriptor.prefix.length))
        if (path !== undefined) candidates.push({ descriptor, path })
      }
    } else if (url.protocol === 'ssh:') {
      const port = url.port === '' ? 22 : Number(url.port)
      const path = projectPath(rawPath)
      if (path !== undefined) candidates = instances.filter(item => item.sshHost === url.hostname && item.sshPort === port).map(descriptor => ({ descriptor, path }))
    }
  }
  if (candidates.length > 1) return { reason: 'ambiguous' }
  const found = candidates[0]
  if (found === undefined) return { reason: 'unregistered' }
  const scope: ScopedRemoteScope = { provider: 'gitlab', instance: found.descriptor.instance }
  return { identity: { provider: 'gitlab', instance: scope.instance, path: found.path, scope } }
}
export async function scopedRepositories(run: RemoteGitRun, root: string, instances: readonly GitLabInstance[], signal: AbortSignal): Promise<ScopedRemoteRepositorySet> {
  const names = (await run(root, ['remote'], signal)).trim().split('\n').filter((name): name is 'origin' | 'upstream' => name === 'origin' || name === 'upstream')
  const remotes: { name: 'origin' | 'upstream'; identity: ScopedDiscoveredIdentity }[] = []
  const unresolved: { name: 'origin' | 'upstream'; reason: 'unregistered' | 'ambiguous' }[] = []
  for (const name of names) {
    const urls = (await run(root, ['remote', 'get-url', '--all', name], signal)).trim().split('\n')
    const found = urls.length === 1 ? parseScopedRemote(urls[0] ?? '', instances) : { reason: 'ambiguous' as const }
    if (found.identity !== undefined) remotes.push({ name, identity: found.identity })
    else unresolved.push({ name, reason: found.reason ?? 'unregistered' })
  }
  return { state: remotes.length ? 'supported' : names.length ? 'unsupported' : 'no-remotes', remotes, ...(unresolved.length ? { unresolved } : {}) }
}
