/** Explicit GitLab projections; never send untrusted provider objects to the Client. */
import { GitRemoteError } from './errors.ts'
import type { RemoteAuthor, ScopedRemoteApprovalFacts, ScopedRemoteCommit, ScopedRemoteDiffLine, ScopedRemoteDiffPosition, ScopedRemoteDiscussion, ScopedRemoteFile, ScopedRemoteIssue, ScopedRemoteNote, ScopedRemotePull } from './provider.ts'

function invalid(): never { throw new GitRemoteError('git/remote-unavailable', 'git-remote: invalid provider response', { reason: 'invalid-response' }) }
function object(value: unknown): Record<string, unknown> { if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid(); return value as Record<string, unknown> }
function str(value: unknown, max = 65536): string { if (typeof value !== 'string' || value.length > max) return invalid(); return value }
function id(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  if (typeof value === 'string' && /^[1-9][0-9]{0,39}$/.test(value)) return value
  return invalid()
}
function iid(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return invalid(); return value }
function nullableSha(value: unknown): string | null { if (value == null) return null; if (typeof value !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) return invalid(); return value }
function optionalTime(value: unknown): string | undefined { return typeof value === 'string' && value.length <= 100 && !/[\x00-\x1f\x7f]/u.test(value) ? value : undefined }

/** Browser links and image URLs have their own policy; API transport policy is not reused. */
export function gitLabWebUrl(instance: string, raw: unknown, image = false): string | undefined {
  if (typeof raw !== 'string' || raw.length > 8192 || /[\\\x00-\x20\x7f]/u.test(raw)) return undefined
  const match = /^https:\/\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?(#[^#]*)?$/iu.exec(raw)
  if (match === null) return undefined
  const rawPath = match[2] ?? '/'
  if (rawPath.includes('//')) return undefined
  for (const segment of rawPath.split('/')) {
    let decoded: string
    try { decoded = decodeURIComponent(segment) } catch { return undefined }
    if (decoded === '.' || decoded === '..' || /[\\/%\x00-\x20\x7f]/u.test(decoded)) return undefined
  }
  let target: URL, base: URL
  try { target = new URL(raw); base = new URL(instance) } catch { return undefined }
  if (target.username || target.password || target.protocol !== 'https:') return undefined
  const prefix = base.pathname === '/' ? '' : base.pathname
  const sameInstance = target.origin === base.origin && (prefix === '' || target.pathname === prefix || target.pathname.startsWith(`${prefix}/`))
  const gravatar = image && target.origin === 'https://secure.gravatar.com'
  if (!sameInstance && !gravatar) return undefined
  if (target.hash && (!/^#[A-Za-z0-9_-]{1,128}$/u.test(target.hash) || image)) return undefined
  // No arbitrary query string is allowed to become a link or an image request.
  if (target.search && !(image && [...target.searchParams].length === 1 && target.searchParams.has('s') && /^[1-9][0-9]{0,2}$/u.test(target.searchParams.get('s') ?? ''))) return undefined
  return target.href
}

function author(value: unknown, instance: string): RemoteAuthor | null {
  if (value == null) return null
  const data = object(value), userId = id(data['id']), login = str(data['username'], 256)
  if (login === '') return invalid()
  const avatarUrl = gitLabWebUrl(instance, data['avatar_url'], true)
  return { userId, login, ...(avatarUrl === undefined ? {} : { avatarUrl }) }
}
function common(data: Record<string, unknown>, instance: string) {
  const url = gitLabWebUrl(instance, data['web_url']), createdAt = optionalTime(data['created_at']), updatedAt = optionalTime(data['updated_at'])
  return { id: id(data['id']), number: iid(data['iid']), title: str(data['title'], 65536), body: data['description'] == null ? '' : str(data['description']), author: author(data['author'], instance), ...(url === undefined ? {} : { url }), ...(createdAt === undefined ? {} : { createdAt }), ...(updatedAt === undefined ? {} : { updatedAt }) }
}
export function gitLabIssue(value: unknown, instance: string, targetProjectId: string): ScopedRemoteIssue {
  const data = object(value), rawState = str(data['state'], 128)
  if (id(data['project_id']) !== targetProjectId) return invalid()
  const state = rawState === 'opened' ? 'open' : rawState === 'closed' ? 'closed' : 'unknown'
  return { ...common(data, instance), state, rawState }
}
export function gitLabPull(value: unknown, instance: string, targetProjectId: string): ScopedRemotePull {
  const data = object(value), rawState = str(data['state'], 128)
  const state = rawState === 'opened' || rawState === 'locked' ? 'open' : rawState === 'closed' ? 'closed' : rawState === 'merged' ? 'merged' : 'unknown'
  const targetId = id(data['target_project_id'])
  if (targetId !== targetProjectId) return invalid()
  const sourceId = data['source_project_id'] == null ? null : id(data['source_project_id'])
  const sourceRef = str(data['source_branch'], 1024), targetRef = str(data['target_branch'], 1024)
  if (!sourceRef || !targetRef) return invalid()
  const refs = data['diff_refs'] == null ? undefined : object(data['diff_refs'])
  const draft = typeof data['draft'] === 'boolean' ? data['draft'] : typeof data['work_in_progress'] === 'boolean' ? data['work_in_progress'] : 'unknown'
  return { ...common(data, instance), state, rawState, draft, head: { projectId: sourceId, ref: sourceRef, sha: nullableSha(data['sha']) }, base: { projectId: targetId, ref: targetRef, sha: refs === undefined ? null : nullableSha(refs['start_sha']) },
    ...(refs === undefined ? {} : { diffRefs: { baseSha: nullableSha(refs['base_sha']), startSha: nullableSha(refs['start_sha']), headSha: nullableSha(refs['head_sha']) } }) }
}

export function gitLabCommit(value: unknown, instance: string): ScopedRemoteCommit {
  const data = object(value), sha = nullableSha(data['id'])
  if (sha === null) return invalid()
  const authorName = typeof data['author_name'] === 'string' ? str(data['author_name'], 1024) : undefined
  const committedAt = optionalTime(data['committed_date']), url = gitLabWebUrl(instance, data['web_url'])
  return { sha, subject: str(data['title'], 65536), ...(authorName === undefined ? {} : { authorName }), ...(committedAt === undefined ? {} : { committedAt }), ...(url === undefined ? {} : { url }) }
}
export function gitLabFile(value: unknown): ScopedRemoteFile {
  const data = object(value), oldPath = str(data['old_path'], 8192), newPath = str(data['new_path'], 8192)
  if (!oldPath || !newPath) return invalid()
  const flags = [data['new_file'], data['deleted_file'], data['renamed_file']]
  if (flags.filter(value => value === true).length > 1) return invalid()
  const status = data['new_file'] === true ? 'added' : data['deleted_file'] === true ? 'deleted' : data['renamed_file'] === true ? 'renamed' : flags.every(value => typeof value === 'boolean') ? 'modified' : 'unknown'
  const content = data['too_large'] === true ? 'too-large' : data['collapsed'] === true ? 'collapsed' : typeof data['diff'] === 'string' && data['diff'] !== '' ? 'available' : 'unavailable'
  return { oldPath, newPath, status, content, ...(content === 'available' ? { patch: str(data['diff'], 4 * 1024 * 1024) } : {}) }
}
function nullableLine(value: unknown): number | null {
  if (value == null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return invalid()
  return value
}
function line(value: unknown): ScopedRemoteDiffLine {
  const data = object(value)
  return { ...(data['line_code'] === undefined ? {} : { lineCode: str(data['line_code'], 1024) }), ...(data['type'] === undefined ? {} : { type: str(data['type'], 128) }),
    ...(data['old_line'] === undefined ? {} : { oldLine: nullableLine(data['old_line']) }), ...(data['new_line'] === undefined ? {} : { newLine: nullableLine(data['new_line']) }) }
}
function position(value: unknown): ScopedRemoteDiffPosition {
  const data = object(value), range = data['line_range'] == null ? undefined : object(data['line_range'])
  const path = (value: unknown) => value === null ? null : str(value, 8192)
  return { baseSha: nullableSha(data['base_sha']), startSha: nullableSha(data['start_sha']), headSha: nullableSha(data['head_sha']),
    ...(data['position_type'] === undefined ? {} : { positionType: str(data['position_type'], 128) }),
    ...(data['old_path'] === undefined ? {} : { oldPath: path(data['old_path']) }), ...(data['new_path'] === undefined ? {} : { newPath: path(data['new_path']) }),
    ...(data['old_line'] === undefined ? {} : { oldLine: nullableLine(data['old_line']) }), ...(data['new_line'] === undefined ? {} : { newLine: nullableLine(data['new_line']) }),
    ...(range === undefined ? {} : { lineRange: { ...(range['start'] == null ? {} : { start: line(range['start']) }), ...(range['end'] == null ? {} : { end: line(range['end']) }) } }) }
}
export function gitLabNote(value: unknown, instance: string, discussionId?: string): ScopedRemoteNote {
  const note = object(value), createdAt = optionalTime(note['created_at']), url = gitLabWebUrl(instance, note['web_url'])
  return { id: id(note['id']), ...(discussionId === undefined ? {} : { discussionId }), body: str(note['body']), author: author(note['author'], instance), system: typeof note['system'] === 'boolean' ? note['system'] : 'unknown',
    ...(typeof note['resolvable'] === 'boolean' ? { resolvable: note['resolvable'] } : {}), ...(typeof note['resolved'] === 'boolean' ? { resolved: note['resolved'] } : {}),
    ...(note['position'] == null ? {} : { position: position(note['position']) }), ...(createdAt === undefined ? {} : { createdAt }), ...(url === undefined ? {} : { url }) }
}
export function gitLabDiscussion(value: unknown, instance: string): ScopedRemoteDiscussion {
  const data = object(value), discussionId = str(data['id'], 256)
  if (!discussionId || /[\x00-\x20\x7f]/u.test(discussionId) || !Array.isArray(data['notes'])) return invalid()
  const notes = data['notes'].map((raw: unknown) => gitLabNote(raw, instance, discussionId))
  return { id: discussionId, notes }
}
export function gitLabApprovals(value: unknown, instance: string, targetProjectId: string, number: number): ScopedRemoteApprovalFacts {
  const data = object(value)
  if ((data['project_id'] !== undefined && id(data['project_id']) !== targetProjectId) || (data['iid'] !== undefined && iid(data['iid']) !== number)) return invalid()
  if (!Array.isArray(data['approved_by'])) return invalid()
  const approvedBy = data['approved_by'].map((item: unknown) => author(object(item)['user'], instance))
  if (approvedBy.some(item => item === null)) return invalid()
  const nonnegative = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
  const approvalsRequired = nonnegative(data['approvals_required']), approvalsLeft = nonnegative(data['approvals_left'])
  return { approvedBy: approvedBy as RemoteAuthor[], ...(typeof data['approved'] === 'boolean' ? { approved: data['approved'] } : {}),
    ...(typeof data['user_has_approved'] === 'boolean' ? { userHasApproved: data['user_has_approved'] } : {}),
    ...(typeof data['user_can_approve'] === 'boolean' ? { userCanApprove: data['user_can_approve'] } : {}),
    ...(approvalsRequired === undefined ? {} : { approvalsRequired }), ...(approvalsLeft === undefined ? {} : { approvalsLeft }) }
}
