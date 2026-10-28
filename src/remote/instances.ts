/** GitLab instance configuration and reversible credential identities (ADR-0005 D2). */
import { readVolatile } from '../compat/dsh-schema.ts'
import { gitRemoteCredentialKey, gitRemoteCredentialRef } from './credentials.ts'
import type { CredentialKey, CredentialRef } from './credentials-types.ts'
import { canonicalGitLabInstance } from './instance-url.ts'
export { canonicalGitLabInstance } from './instance-url.ts'

export const GITLAB_COM = 'https://gitlab.com'
export interface GitLabInstanceSettings {
  url: string
  label?: string
  clientId?: string
  credentialRef?: string
  sshHost?: string
  sshPort?: number
}
export interface GitLabInstance {
  readonly provider: 'gitlab'
  readonly instance: string
  readonly hostname: string
  readonly prefix: string
  readonly sshHost: string
  readonly sshPort: number
  readonly label?: string
  readonly clientId?: string
  readonly credentialRef?: CredentialRef
}

function invalid(reason: string): never { throw new TypeError(`git-remote: invalid instance configuration (${reason})`) }

/** RFC 4648 base32, lowercase and unpadded, over the canonical UTF-8 bytes. */
export function gitLabHostId(instance: string): string {
  const canonical = canonicalGitLabInstance(instance)
  if (canonical === GITLAB_COM) return 'gitlab-com'
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  let bits = 0
  let buffer = 0
  let result = 'gl-'
  for (const byte of new TextEncoder().encode(canonical)) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) { bits -= 5; result += alphabet[(buffer >>> bits) & 31] }
    buffer &= (1 << bits) - 1
  }
  if (bits > 0) result += alphabet[(buffer << (5 - bits)) & 31]
  return result
}
export function gitLabGrantKey(instance: string): CredentialKey {
  return gitRemoteCredentialKey('dsh-plugin-git', gitLabHostId(instance))
}
function sshHostname(input: string): string {
  if (!input || /[\s\x00-\x1f\x7f\\/?#@%]/u.test(input) || (input.startsWith('[') ? !input.endsWith(']') : input.includes(':'))) return invalid('ssh-host')
  let url: URL
  try { url = new URL(`https://${input}`) } catch { return invalid('ssh-host') }
  if (!url.hostname || url.port || url.username || url.password || url.pathname !== '/') return invalid('ssh-host')
  return url.hostname
}
function optionalString(value: unknown, reason: string, max: number): string | undefined {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/u.test(value)) return invalid(reason)
  return value
}

export function resolveGitLabInstances(source: unknown): readonly GitLabInstance[] {
  const input = readVolatile(source)
  if (input === undefined) return [makeInstance({ url: GITLAB_COM })]
  if (!Array.isArray(input) || input.length > 16) return invalid('instances')
  const instances = new Map<string, GitLabInstance>()
  const refs = new Set<string>()
  for (const item of input) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return invalid('instance')
    const instance = makeInstance(item as Record<string, unknown>)
    if (instances.has(instance.instance)) return invalid('duplicate-url')
    if (instance.credentialRef !== undefined) {
      if (refs.has(instance.credentialRef)) return invalid('duplicate-ref')
      refs.add(instance.credentialRef)
    }
    instances.set(instance.instance, instance)
  }
  if (!instances.has(GITLAB_COM)) instances.set(GITLAB_COM, makeInstance({ url: GITLAB_COM }))
  return [...instances.values()]
}
function makeInstance(input: Record<string, unknown>): GitLabInstance {
  const rawUrl = readVolatile(input['url'])
  if (typeof rawUrl !== 'string') return invalid('url')
  const instance = canonicalGitLabInstance(rawUrl)
  const parsed = new URL(instance)
  const label = optionalString(readVolatile(input['label']), 'label', 256)
  const clientId = optionalString(readVolatile(input['clientId']), 'client-id', 512)
  if (clientId !== undefined && /\s/u.test(clientId)) return invalid('client-id')
  const refValue = optionalString(readVolatile(input['credentialRef']), 'credential-ref', 256)
  let credentialRef: CredentialRef | undefined
  if (refValue !== undefined) {
    try { credentialRef = gitRemoteCredentialRef(refValue) } catch { return invalid('credential-ref') }
    if (refValue === 'GH_TOKEN' || refValue === 'GITHUB_TOKEN' || (instance !== GITLAB_COM && (refValue === 'GITLAB_TOKEN' || refValue === 'GL_TOKEN'))) return invalid('reserved-ref')
  }
  const sshInput = readVolatile(input['sshHost'])
  const sshHost = sshInput === undefined || sshInput === '' ? parsed.hostname : typeof sshInput === 'string' ? sshHostname(sshInput) : invalid('ssh-host')
  const port = readVolatile(input['sshPort'])
  const sshPort = port === undefined ? 22 : port
  if (typeof sshPort !== 'number' || !Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) return invalid('ssh-port')
  return { provider: 'gitlab', instance, hostname: parsed.hostname, prefix: parsed.pathname === '/' ? '' : parsed.pathname, sshHost, sshPort, ...(label === undefined ? {} : { label }), ...(clientId === undefined ? {} : { clientId }), ...(credentialRef === undefined ? {} : { credentialRef }) }
}

/** Labels are presentation only and do not invalidate an instance owner. */
export function sameGitLabInstanceConfiguration(a: GitLabInstance, b: GitLabInstance): boolean {
  return a.instance === b.instance && a.clientId === b.clientId && a.credentialRef === b.credentialRef && a.sshHost === b.sshHost && a.sshPort === b.sshPort
}
