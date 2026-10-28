/** Provider-neutral view model for the shared remote UI, plus scoped-model projections. */
import type { RemoteComment, RemoteCommit, RemoteIssue, RemotePage, RemotePull, RemoteRepository, ScopedGitLabRepository, ScopedRemoteCommit, ScopedRemoteDiscussion, ScopedRemoteIssue, ScopedRemoteNote, ScopedRemotePull } from '../../remote/provider.ts'
import type { ScopedRemoteScope } from '../../remote/types.ts'
import { ScopedProtocolError } from '../remote-protocol.ts'

/** Any repository identity a remote view can be bound to. */
export type RemoteTarget = RemoteRepository | ScopedGitLabRepository

/** A remote name plus its provider-aware identity, as discovered for the workspace. */
export interface RemoteBoundRemote { readonly name: 'origin' | 'upstream'; readonly identity: RemoteTarget }

/** A configured origin/upstream whose URL matched no supported provider. */
export interface RemoteUnresolvedRemote { readonly name: 'origin' | 'upstream'; readonly reason: 'unregistered' | 'ambiguous' }

/** Pull/issue row or detail from either provider. */
export type RemoteItem = RemotePull | RemoteIssue | ScopedRemotePull | ScopedRemoteIssue

/** Conversation comment. GitLab notes add moderation/resolution facts; GitHub comments leave them absent. */
export type RemoteCommentView = RemoteComment & {
  readonly system?: boolean | 'unknown'
  readonly resolvable?: boolean
  readonly resolved?: boolean
}

export type RemoteCommitView = RemoteCommit | ScopedRemoteCommit

/** Normalized write result shared by scoped providers. */
export interface RemoteWriteOutcome {
  readonly outcome: 'succeeded' | 'partial' | 'unknown'
  readonly steps: readonly { readonly kind: string; readonly state: 'succeeded' | 'failed' | 'unknown' | 'not-sent'; readonly id?: string; readonly reason?: string }[]
  readonly receipt?: unknown
}

/** Two-step destructive-action confirmation bound to one identity snapshot. */
export interface RemoteConfirmation {
  readonly action: 'close' | 'merge'
  readonly method?: 'merge' | 'squash'
  readonly identity: string
  readonly number: number
  readonly sha: string
}

export interface RemoteLoginAttempt { readonly attemptId: string; readonly userCode: string; readonly verificationUri: string }

/** The constant scope GitHub scoped requests are dispatched under. */
export const GITHUB_SCOPE: ScopedRemoteScope = { provider: 'github', instance: 'https://github.com' }

export function remoteTargetScope(target: RemoteTarget): ScopedRemoteScope {
  return target.provider === 'gitlab' ? target.scope : GITHUB_SCOPE
}

export function sameRemoteTarget(a: RemoteTarget | undefined, b: RemoteTarget | undefined): boolean {
  if (a === undefined || b === undefined || a.provider !== b.provider) return false
  if (a.provider === 'gitlab' && b.provider === 'gitlab') return a.instance === b.instance && a.path === b.path
  const githubA = a as RemoteRepository, githubB = b as RemoteRepository
  return githubA.host === githubB.host && githubA.owner.toLowerCase() === githubB.owner.toLowerCase() && githubA.repo.toLowerCase() === githubB.repo.toLowerCase()
}

/** Human label without a remote-name prefix: `owner/repo` or `host/path`. */
export function remoteTargetLabel(target: RemoteTarget): string {
  if (target.provider === 'gitlab') return `${new URL(target.instance).host}${new URL(target.instance).pathname === '/' ? '' : new URL(target.instance).pathname}/${target.path}`
  return `${target.owner}/${target.repo}`
}

/** Machine key used for controller view keys and list cache keys. */
export function remoteTargetKey(target: RemoteTarget | undefined): string {
  if (target === undefined) return ''
  if (target.provider === 'gitlab') return `gitlab/${target.instance}/${target.path}`
  return `github/${target.owner.toLowerCase()}/${target.repo.toLowerCase()}`
}

/** Scoped list pages must carry an explicit truncation flag consistent with the cursor. */
export function strictPage<T>(value: unknown): RemotePage<T> {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as { items?: unknown }).items)) throw new ScopedProtocolError('invalid-response')
  const raw = value as { items: T[]; truncated?: unknown; next?: unknown }
  if (typeof raw.truncated !== 'boolean' || (raw.next !== undefined && typeof raw.next !== 'string') || raw.truncated !== (raw.next !== undefined)) throw new ScopedProtocolError('invalid-response')
  return { items: raw.items, truncated: raw.truncated, ...(raw.next === undefined ? {} : { next: raw.next }) }
}

/** Project a GitLab note onto the shared conversation-comment view. */
export function projectGitLabNote(note: ScopedRemoteNote): RemoteCommentView {
  return {
    id: note.id,
    body: note.body,
    author: note.author,
    outdated: false,
    ...(note.url === undefined ? {} : { url: note.url }),
    ...(note.createdAt === undefined ? {} : { createdAt: note.createdAt }),
    system: note.system,
    ...(note.resolvable === undefined ? {} : { resolvable: note.resolvable }),
    ...(note.resolved === undefined ? {} : { resolved: note.resolved }),
  }
}

/** Flatten a GitLab discussion into a reply-chained inline thread. */
export function projectGitLabDiscussion(discussion: ScopedRemoteDiscussion): RemoteCommentView[] {
  return discussion.notes.map((note, index) => {
    const position = note.position
    const path = position?.newPath ?? position?.oldPath
    const line = position?.newLine ?? position?.oldLine
    return {
      ...projectGitLabNote(note),
      ...(index === 0 ? {} : { replyTo: discussion.notes[index - 1]!.id }),
      ...(path === undefined || path === null ? {} : { path }),
      ...(line === undefined || line === null ? {} : { line }),
    }
  })
}
