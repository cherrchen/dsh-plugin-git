/** Browser-safe canonical GitLab instance identity shared across Host and Client. */
function invalid(reason: string): never { throw new TypeError(`git-remote: invalid instance configuration (${reason})`) }

/** Validate raw input before URL parsing, which otherwise removes dot segments. */
export function canonicalGitLabInstance(input: string): string {
  if (typeof input !== 'string' || /[\s\x00-\x1f\x7f\\?#]/u.test(input)) return invalid('url')
  const match = /^https:\/\/([^/]+)(\/.*)?$/i.exec(input)
  if (match === null || !match[1] || /[@%]/.test(match[1]) || match[1].endsWith(':')) return invalid('url')
  const rawPath = match[2] ?? ''
  if (rawPath.includes('%') || rawPath.includes('//')) return invalid('path')
  const segments = rawPath.split('/').slice(1)
  if (segments.at(-1) === '') segments.pop()
  if (segments.some(segment => segment === '.' || segment === '..' || !/^[A-Za-z0-9._~-]+$/.test(segment))) return invalid('path')
  let url: URL
  try { url = new URL(input) } catch { return invalid('url') }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || !url.hostname || url.port === '0' || url.search !== '' || url.hash !== '') return invalid('url')
  const canonical = `${url.origin}${segments.length === 0 ? '' : `/${segments.join('/')}`}`
  if (new TextEncoder().encode(canonical).byteLength > 512) return invalid('url-length')
  return canonical
}
