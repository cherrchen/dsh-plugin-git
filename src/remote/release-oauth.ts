/** Public application IDs supplied by the publisher at build time; never client secrets. */
declare const __DSH_GIT_OAUTH_CLIENT_IDS__: { readonly github?: string; readonly gitlab?: string } | undefined

export function releaseOAuthClientId(provider: 'github' | 'gitlab'): string | undefined {
  return typeof __DSH_GIT_OAUTH_CLIENT_IDS__ === 'undefined' ? undefined : __DSH_GIT_OAUTH_CLIENT_IDS__?.[provider]
}

/** An explicit empty string disables a release default. */
export function effectiveOAuthClientId(explicit: unknown, provider: 'github' | 'gitlab'): string | undefined {
  const value = explicit === undefined ? releaseOAuthClientId(provider) : explicit
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || value.length > 512 || /[\s\x00-\x1f\x7f]/u.test(value)) throw new TypeError('git-remote: invalid OAuth client ID')
  return value
}
