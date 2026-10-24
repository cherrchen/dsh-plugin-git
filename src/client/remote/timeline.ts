/** Chronological ordering for the pull/issue detail: interleaves comments, commits, reviews and inline threads. */
import type { RemoteComment, RemoteCommit, RemoteReview } from '../../remote/provider.ts'

export interface RemoteThread {
  readonly root: RemoteComment
  readonly replies: readonly RemoteComment[]
}

export type RemoteTimelineEntry =
  | { readonly kind: 'comment'; readonly key: string; readonly at?: string | undefined; readonly comment: RemoteComment }
  | { readonly kind: 'commit'; readonly key: string; readonly at?: string | undefined; readonly commit: RemoteCommit }
  | { readonly kind: 'review'; readonly key: string; readonly at?: string | undefined; readonly review: RemoteReview; readonly threads: readonly RemoteThread[] }
  | { readonly kind: 'thread'; readonly key: string; readonly at?: string | undefined; readonly thread: RemoteThread }

const time = (at: string | undefined): number => (at === undefined ? Number.NaN : Date.parse(at))

export function remoteTimeline(input: {
  readonly comments: readonly RemoteComment[]
  readonly inline: readonly RemoteComment[]
  readonly commits: readonly RemoteCommit[]
  readonly reviews: readonly RemoteReview[]
}): readonly RemoteTimelineEntry[] {
  const byId = new Map(input.inline.map(comment => [comment.id, comment]))
  const replies = new Map<string, RemoteComment[]>()
  const roots: RemoteComment[] = []
  for (const comment of input.inline) {
    if (comment.replyTo === undefined || !byId.has(comment.replyTo)) roots.push(comment)
  }
  const rootsById = new Map(roots.map(root => [root.id, root]))
  for (const comment of input.inline) {
    if (rootsById.has(comment.id)) continue
    let cursor = comment
    const seen = new Set([comment.id])
    while (cursor.replyTo !== undefined) {
      const next = byId.get(cursor.replyTo)
      if (next === undefined || seen.has(next.id)) break
      seen.add(next.id)
      cursor = next
    }
    if (rootsById.has(cursor.id)) {
      const list = replies.get(cursor.id) ?? []
      list.push(comment)
      replies.set(cursor.id, list)
    } else {
      // The reply chain resolves to a missing root: keep the comment as its own thread.
      roots.push(comment)
      rootsById.set(comment.id, comment)
    }
  }
  const threads = roots.map(root => {
    const list = [...(replies.get(root.id) ?? [])].sort((a, b) => time(a.createdAt) - time(b.createdAt))
    return { root, replies: list } satisfies RemoteThread
  })
  const reviewById = new Map(input.reviews.map(review => [review.id, review]))
  const threadsByReview = new Map<string, RemoteThread[]>()
  const standalone: RemoteThread[] = []
  for (const thread of threads) {
    const owner = thread.root.reviewId !== undefined && reviewById.has(thread.root.reviewId) ? thread.root.reviewId : undefined
    if (owner === undefined) standalone.push(thread)
    else {
      const list = threadsByReview.get(owner) ?? []
      list.push(thread)
      threadsByReview.set(owner, list)
    }
  }
  const entries: RemoteTimelineEntry[] = []
  for (const commit of input.commits) entries.push({ kind: 'commit', key: `commit:${commit.sha}`, at: commit.committedAt ?? commit.date, commit })
  for (const comment of input.comments) entries.push({ kind: 'comment', key: `comment:${comment.id}`, at: comment.createdAt, comment })
  for (const thread of standalone) entries.push({ kind: 'thread', key: `thread:${thread.root.id}`, at: thread.root.createdAt, thread })
  for (const review of input.reviews) {
    const owned = threadsByReview.get(review.id) ?? []
    if (review.body === '' && owned.length === 0 && review.state === 'commented') continue
    entries.push({ kind: 'review', key: `review:${review.id}`, at: review.submittedAt, review, threads: owned })
  }
  return entries.slice().sort((a, b) => {
    const at = time(a.at)
    const bt = time(b.at)
    if (Number.isNaN(at)) return Number.isNaN(bt) ? 0 : 1
    if (Number.isNaN(bt)) return -1
    return at - bt
  })
}
