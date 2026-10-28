/** Portable remote models. Provider responses are projected explicitly; raw transport objects never cross RPC. */
import type { GitRemoteActions, GitRemoteGeneration, GitRemotePermissions, GitRemoteViewer, GitRemoteWriteContext } from './types.ts'

export interface RemoteRepository {
  readonly provider: 'github'
  readonly host: 'github.com'
  readonly owner: string
  readonly repo: string
}
export interface RemoteAuthor { readonly userId: string; readonly login: string; readonly avatarUrl?: string }
export interface RemoteBranch { readonly repository: RemoteRepository | null; readonly ref: string; readonly sha: string }
export interface RemoteIssue {
  readonly number: number
  readonly title: string
  readonly body: string
  readonly state: 'open' | 'closed'
  readonly rawState: string
  readonly author: RemoteAuthor | null
  readonly url?: string
  readonly createdAt?: string
}
export interface RemotePull extends Omit<RemoteIssue, 'state'> {
  readonly state: 'open' | 'closed' | 'merged'
  readonly head: RemoteBranch
  readonly base: RemoteBranch
  readonly draft: boolean
}
export interface RemoteComment {
  readonly id: string
  readonly body: string
  readonly author: RemoteAuthor | null
  readonly url?: string
  readonly path?: string
  readonly line?: number
  readonly side?: 'LEFT' | 'RIGHT'
  readonly startLine?: number
  readonly startSide?: 'LEFT' | 'RIGHT'
  readonly commitSha?: string
  readonly replyTo?: string
  /** Owning review id for inline review comments; absent on conversation comments. */
  readonly reviewId?: string
  readonly outdated: boolean
  readonly createdAt?: string
}
/** One commit belonging to a pull request's head history. */
export interface RemoteCommit {
  readonly sha: string
  readonly subject: string
  readonly author: RemoteAuthor | null
  readonly date?: string
  readonly committedAt?: string
  readonly url?: string
}
export type RemoteReviewState = 'approved' | 'changes-requested' | 'commented' | 'dismissed' | 'pending'
/** One submitted review on a pull request; inline comments reference it via `reviewId`. */
export interface RemoteReview {
  readonly id: string
  readonly author: RemoteAuthor | null
  readonly state: RemoteReviewState
  readonly rawState: string
  readonly body: string
  readonly url?: string
  readonly submittedAt?: string
  readonly commitSha?: string
}
export interface RemoteFile {
  readonly path: string
  readonly previousPath?: string
  readonly status: string
  readonly additions: number
  readonly deletions: number
  readonly patch?: string
}
export interface RemotePage<T> { readonly items: readonly T[]; readonly truncated: boolean; readonly next?: string }
/** Progressive read request: resume from the opaque `cursor` and fetch at most `pages` upstream pages. */
export interface RemotePageRequest { readonly cursor?: string; readonly pages?: number }
export interface RemoteReadContext { readonly signal: AbortSignal; readonly automatic?: boolean; readonly beforeSend?: () => Promise<void> }
export interface RemoteResult<T> { readonly generation: GitRemoteGeneration; readonly value: T }
export interface RemoteRepositoryFacts {
  readonly viewer?: GitRemoteViewer
  readonly permissions: GitRemotePermissions
  readonly actions: GitRemoteActions
}
export interface RemoteProvider {
  readonly id: string
  readonly apiOrigin: string
  readonly webOrigin: string
  headRefspec(number: number): string
  repository(repo: RemoteRepository, context: RemoteReadContext): Promise<RemoteResult<RemoteRepositoryFacts>>
  pulls(repo: RemoteRepository, state: 'open' | 'closed' | 'all', page: RemotePageRequest, context: RemoteReadContext): Promise<RemoteResult<RemotePage<RemotePull>>>
  pull(repo: RemoteRepository, number: number, context: RemoteReadContext): Promise<RemoteResult<RemotePull>>
  issues(repo: RemoteRepository, state: 'open' | 'closed' | 'all', page: RemotePageRequest, context: RemoteReadContext): Promise<RemoteResult<RemotePage<RemoteIssue>>>
  issue(repo: RemoteRepository, number: number, context: RemoteReadContext): Promise<RemoteResult<RemoteIssue>>
  comments(repo: RemoteRepository, number: number, inline: boolean, page: RemotePageRequest, context: RemoteReadContext): Promise<RemoteResult<RemotePage<RemoteComment>>>
  files(repo: RemoteRepository, number: number, page: RemotePageRequest, context: RemoteReadContext): Promise<RemoteResult<RemotePage<RemoteFile>>>
  commits(repo: RemoteRepository, number: number, page: RemotePageRequest, context: RemoteReadContext): Promise<RemoteResult<RemotePage<RemoteCommit>>>
  reviews(repo: RemoteRepository, number: number, page: RemotePageRequest, context: RemoteReadContext): Promise<RemoteResult<RemotePage<RemoteReview>>>
  write(repo: RemoteRepository, expected: GitRemoteWriteContext, command: RemoteWrite, context: RemoteReadContext): Promise<RemoteResult<RemoteWriteReceipt>>
  notifications(repo: RemoteRepository, context: RemoteReadContext): Promise<RemoteResult<RemotePage<RemoteNotice>>>
  dispose(): Promise<void>
}

export type RemoteWrite =
  | { readonly kind: 'comment'; readonly number: number; readonly body: string }
  | { readonly kind: 'inline-comment'; readonly number: number; readonly body: string; readonly expectedHeadSha: string; readonly path: string; readonly line: number; readonly side: 'LEFT' | 'RIGHT'; readonly startLine?: number; readonly startSide?: 'LEFT' | 'RIGHT' }
  | { readonly kind: 'review'; readonly number: number; readonly body: string; readonly expectedHeadSha: string; readonly event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES' }
  | { readonly kind: 'close-pr'; readonly number: number; readonly expectedHeadSha: string }
  | { readonly kind: 'merge-pr'; readonly number: number; readonly expectedHeadSha: string; readonly method: 'merge' | 'squash' | 'rebase' }
  | { readonly kind: 'create-pr'; readonly title: string; readonly body: string; readonly head: RemoteRepository; readonly headRef: string; readonly baseRef: string; readonly draft: boolean }
export interface RemoteWriteReceipt { readonly id?: string; readonly number?: number; readonly url?: string; readonly merged?: boolean }
export interface RemoteNotice { readonly id: string; readonly kind: 'review-requested' | 'merged' | 'closed' | 'changes-requested' | 'create-pr'; readonly title: string; readonly url?: string }

/** Additive scoped models. These do not widen the published GitHub v1 models above. */
export interface ScopedGitLabRepository {
  readonly provider: 'gitlab'
  readonly instance: string
  readonly path: string
  readonly projectId?: string
  readonly scope: import('./types.ts').ScopedRemoteScope
}
export type ScopedRemoteRepository = (RemoteRepository & { readonly scope: import('./types.ts').ScopedRemoteScope }) | ScopedGitLabRepository
export interface ScopedRemoteIssue {
  /** Global API object id and project-local iid are separate identities. */
  readonly id: string
  readonly number: number
  readonly title: string
  readonly body: string
  readonly state: 'open' | 'closed' | 'unknown'
  readonly rawState: string
  readonly author: RemoteAuthor | null
  readonly url?: string
  readonly createdAt?: string
  readonly updatedAt?: string
}
export interface ScopedRemoteBranch {
  readonly projectId: string | null
  readonly ref: string
  /** Null means the API did not supply this branch's SHA; it is not guessed. */
  readonly sha: string | null
}
export interface ScopedRemotePull extends Omit<ScopedRemoteIssue, 'state'> {
  readonly state: 'open' | 'closed' | 'merged' | 'unknown'
  readonly head: ScopedRemoteBranch
  readonly base: ScopedRemoteBranch
  readonly draft: boolean | 'unknown'
  readonly diffRefs?: { readonly baseSha: string | null; readonly startSha: string | null; readonly headSha: string | null }
}
export interface ScopedRemoteCommit {
  readonly sha: string
  readonly subject: string
  readonly authorName?: string
  readonly committedAt?: string
  readonly url?: string
}
export interface ScopedRemoteFile {
  readonly oldPath: string
  readonly newPath: string
  readonly status: 'added' | 'deleted' | 'renamed' | 'modified' | 'unknown'
  readonly content: 'available' | 'collapsed' | 'too-large' | 'unavailable'
  readonly patch?: string
}
export interface ScopedRemoteDiffLine {
  readonly lineCode?: string
  readonly type?: string
  readonly oldLine?: number | null
  readonly newLine?: number | null
}
export interface ScopedRemoteDiffPosition {
  readonly positionType?: string
  readonly baseSha: string | null
  readonly startSha: string | null
  readonly headSha: string | null
  readonly oldPath?: string | null
  readonly newPath?: string | null
  readonly oldLine?: number | null
  readonly newLine?: number | null
  readonly lineRange?: { readonly start?: ScopedRemoteDiffLine; readonly end?: ScopedRemoteDiffLine }
}
export interface ScopedRemoteNote {
  readonly id: string
  readonly discussionId?: string
  readonly body: string
  readonly author: RemoteAuthor | null
  readonly system: boolean | 'unknown'
  readonly resolvable?: boolean
  readonly resolved?: boolean
  readonly position?: ScopedRemoteDiffPosition
  readonly createdAt?: string
  readonly url?: string
}
export interface ScopedRemoteDiscussion { readonly id: string; readonly notes: readonly ScopedRemoteNote[] }
/** Current approval facts, not synthetic review history. */
export interface ScopedRemoteApprovalFacts {
  readonly approved?: boolean
  readonly userHasApproved?: boolean
  readonly userCanApprove?: boolean
  readonly approvalsRequired?: number
  readonly approvalsLeft?: number
  readonly approvedBy: readonly RemoteAuthor[]
}
/** Project-bound GitLab notice; the v1 GitHub notice type remains unchanged. */
export interface ScopedRemoteNotice {
  readonly id: string
  readonly projectId: string
  readonly objectId: string
  readonly number: number
  readonly kind: 'review-requested' | 'merged' | 'closed' | 'create-pr'
  readonly title: string
  readonly state: string
  readonly updatedAt?: string
  readonly url?: string
}
export interface ScopedOperationSupport {
  readonly supported: boolean
  readonly reason?: string
}
export interface ScopedRemoteRepositoryFacts {
  readonly actionScope: { readonly path: string; readonly projectId?: string; readonly object?: { readonly kind: 'pull' | 'issue'; readonly number: number } }
  readonly viewer?: GitRemoteViewer
  readonly permissions: GitRemotePermissions
  readonly actions: GitRemoteActions
  readonly operationSupport: Readonly<Record<'comment' | 'inline-comment' | 'review' | 'close-pr' | 'merge-pr' | 'create-pr', ScopedOperationSupport>>
  readonly supportedMergeMethods: readonly ('merge' | 'squash')[]
  readonly supportedReviewEvents: readonly ('COMMENT' | 'APPROVE' | 'REQUEST_CHANGES')[]
  readonly reviewPermissions?: Readonly<Record<'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES', boolean | 'unknown'>>
}
