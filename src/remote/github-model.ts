/** Strict GitHub-to-neutral projections and independent API/browser URL boundaries. */
import { GitRemoteError } from './errors.ts'
import type { RemoteAuthor, RemoteBranch, RemoteComment, RemoteCommit, RemoteFile, RemoteIssue, RemotePull, RemoteRepository, RemoteReview, RemoteReviewState } from './provider.ts'
import { GIT_REMOTE_API_ORIGIN, GIT_REMOTE_WEB_ORIGIN } from './http.ts'

export function invalidResponse(): never { throw new GitRemoteError('git/remote-unavailable', 'git-remote: invalid provider response') }
export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalidResponse()
  return value as Record<string, unknown>
}
export function string(value: unknown): string { return typeof value === 'string' ? value : invalidResponse() }
export function number(value: unknown): number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : invalidResponse() }
export function browserUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    if (url.origin === GIT_REMOTE_WEB_ORIGIN && url.username === '' && url.password === '') return url.href
  } catch { /* Untrusted browser links are omitted. */ }
  return undefined
}
/** Avatar images are admitted only from GitHub's dedicated avatar host. */
export function avatarUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    if (url.origin === 'https://avatars.githubusercontent.com' && url.username === '' && url.password === '') return url.href
  } catch { /* Untrusted image sources are omitted. */ }
  return undefined
}
export function apiPath(value: string): string {
  let url: URL
  try { url = new URL(value, GIT_REMOTE_API_ORIGIN) } catch { return invalidResponse() }
  if (url.origin !== GIT_REMOTE_API_ORIGIN || url.username !== '' || url.password !== '' || url.hash !== '') return invalidResponse()
  return url.pathname + url.search
}
export function repositoryPath(repo: RemoteRepository): string {
  if (repo.provider !== 'github' || repo.host !== 'github.com' || !/^[A-Za-z0-9-]+$/.test(repo.owner) || !/^[A-Za-z0-9_.-]+$/.test(repo.repo) || repo.repo === '.' || repo.repo === '..') {
    throw new GitRemoteError('git/remote-identity-mismatch', 'git-remote: unsupported repository identity')
  }
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`
}
export function objectNumber(n: number): number { if (!Number.isSafeInteger(n) || n < 1) return invalidResponse(); return n }
function author(value: unknown): RemoteAuthor | null {
  if (value == null) return null
  const user = object(value)
  const avatar = avatarUrl(user['avatar_url'])
  return { userId: String(number(user['id'])), login: string(user['login']), ...(avatar === undefined ? {} : { avatarUrl: avatar }) }
}
function branch(value: unknown): RemoteBranch {
  const data = object(value)
  let repository: RemoteRepository | null = null
  if (data['repo'] != null) {
    const repo = object(data['repo'])
    repository = { provider: 'github', host: 'github.com', owner: string(object(repo['owner'])['login']), repo: string(repo['name']) }
    repositoryPath(repository)
  }
  const sha = string(data['sha'])
  if (!/^[0-9a-f]{40,64}$/.test(sha)) return invalidResponse()
  return { repository, ref: string(data['ref']), sha }
}
export function issue(value: unknown): RemoteIssue {
  const data = object(value)
  const rawState = string(data['state'])
  if (rawState !== 'open' && rawState !== 'closed') return invalidResponse()
  const url = browserUrl(data['html_url'])
  return { number: objectNumber(number(data['number'])), title: string(data['title']), body: data['body'] == null ? '' : string(data['body']), state: rawState, rawState, author: author(data['user']), ...(url === undefined ? {} : { url }), ...(typeof data['created_at'] !== 'string' ? {} : { createdAt: data['created_at'] }) }
}
export function pull(value: unknown): RemotePull {
  const data = object(value)
  return { ...issue(data), state: data['merged_at'] != null || data['merged'] === true ? 'merged' : issue(data).state, head: branch(data['head']), base: branch(data['base']), draft: data['draft'] === true }
}
export function comment(value: unknown): RemoteComment {
  const data = object(value)
  const url = browserUrl(data['html_url'])
  return {
    id: String(number(data['id'])), body: string(data['body']), author: author(data['user']), outdated: data['path'] !== undefined && data['line'] == null,
    ...(url === undefined ? {} : { url }),
    ...(typeof data['path'] !== 'string' ? {} : { path: data['path'] }),
    ...(typeof data['line'] !== 'number' ? {} : { line: number(data['line']) }),
    ...(data['side'] !== 'LEFT' && data['side'] !== 'RIGHT' ? {} : { side: data['side'] }),
    ...(typeof data['start_line'] !== 'number' ? {} : { startLine: number(data['start_line']) }),
    ...(data['start_side'] !== 'LEFT' && data['start_side'] !== 'RIGHT' ? {} : { startSide: data['start_side'] }),
    ...(typeof data['commit_id'] !== 'string' ? {} : { commitSha: data['commit_id'] }),
    ...(typeof data['in_reply_to_id'] !== 'number' ? {} : { replyTo: String(number(data['in_reply_to_id'])) }),
    ...(typeof data['pull_request_review_id'] !== 'number' ? {} : { reviewId: String(number(data['pull_request_review_id'])) }),
    ...(typeof data['created_at'] !== 'string' ? {} : { createdAt: data['created_at'] }),
  }
}
export function file(value: unknown): RemoteFile {
  const data = object(value)
  return { path: string(data['filename']), status: string(data['status']), additions: number(data['additions']), deletions: number(data['deletions']), ...(typeof data['previous_filename'] !== 'string' ? {} : { previousPath: data['previous_filename'] }), ...(typeof data['patch'] !== 'string' ? {} : { patch: data['patch'] }) }
}
export function commit(value: unknown): RemoteCommit {
  const data = object(value)
  const sha = string(data['sha'])
  if (!/^[0-9a-f]{40,64}$/.test(sha)) return invalidResponse()
  const inner = object(data['commit'])
  const authored = inner['author'] == null ? undefined : object(inner['author'])['date']
  const committed = inner['committer'] == null ? undefined : object(inner['committer'])['date']
  const url = browserUrl(data['html_url'])
  return {
    sha,
    subject: string(inner['message']).split('\n', 1)[0] ?? '',
    author: author(data['author']),
    ...(typeof authored !== 'string' ? {} : { date: authored }),
    ...(typeof committed !== 'string' ? {} : { committedAt: committed }),
    ...(url === undefined ? {} : { url }),
  }
}
const REVIEW_STATES: Record<string, RemoteReviewState> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes-requested', COMMENTED: 'commented', DISMISSED: 'dismissed', PENDING: 'pending' }
export function review(value: unknown): RemoteReview {
  const data = object(value)
  const rawState = string(data['state'])
  const url = browserUrl(data['html_url'])
  return {
    id: String(number(data['id'])),
    author: author(data['user']),
    state: REVIEW_STATES[rawState] ?? 'commented',
    rawState,
    body: data['body'] == null ? '' : string(data['body']),
    ...(url === undefined ? {} : { url }),
    ...(typeof data['submitted_at'] !== 'string' ? {} : { submittedAt: data['submitted_at'] }),
    ...(typeof data['commit_id'] !== 'string' ? {} : { commitSha: data['commit_id'] }),
  }
}
