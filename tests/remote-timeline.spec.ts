import { describe, expect, it } from 'vitest'
import { remoteTimeline } from '../src/client/remote/timeline.ts'
import type { RemoteComment, RemoteCommit, RemoteReview } from '../src/remote/provider.ts'

const comment = (id: string, extra: Partial<RemoteComment> = {}): RemoteComment => ({ id, body: id, author: null, outdated: false, ...extra })
const commit = (sha: string, extra: Partial<RemoteCommit> = {}): RemoteCommit => ({ sha, subject: sha, author: null, ...extra })
const review = (id: string, extra: Partial<RemoteReview> = {}): RemoteReview => ({ id, author: null, state: 'commented', rawState: 'COMMENTED', body: '', ...extra })

describe('remoteTimeline', () => {
  it('interleaves comments, commits, reviews and threads by timestamp', () => {
    const entries = remoteTimeline({
      comments: [comment('c1', { createdAt: '2024-01-02T00:00:00Z' }), comment('c2', { createdAt: '2024-01-05T00:00:00Z' })],
      inline: [comment('i1', { createdAt: '2024-01-03T00:00:00Z' })],
      commits: [commit('a'.repeat(40), { date: '2024-01-01T00:00:00Z' })],
      reviews: [review('r1', { submittedAt: '2024-01-04T00:00:00Z', body: 'note' })],
    })
    expect(entries.map(e => e.key)).toEqual(['commit:' + 'a'.repeat(40), 'comment:c1', 'thread:i1', 'review:r1', 'comment:c2'])
  })
  it('attaches replies to the root thread and hides empty per-reply reviews', () => {
    const entries = remoteTimeline({
      comments: [],
      inline: [
        comment('i2', { reviewId: 'r9', replyTo: 'i1', createdAt: '2024-01-03T00:00:00Z' }),
        comment('i1', { reviewId: 'r9', createdAt: '2024-01-02T00:00:00Z' }),
      ],
      commits: [],
      reviews: [review('r9', { submittedAt: '2024-01-04T00:00:00Z' })],
    })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'review', key: 'review:r9' })
    const threads = entries[0]!.kind === 'review' ? entries[0]!.threads : []
    expect(threads).toHaveLength(1)
    expect(threads[0]!.root.id).toBe('i1')
    expect(threads[0]!.replies.map(c => c.id)).toEqual(['i2'])
  })
  it('emits standalone threads for orphans and unknown review ids', () => {
    const entries = remoteTimeline({
      comments: [],
      inline: [comment('o1', { reviewId: 'missing', createdAt: '2024-01-01T00:00:00Z' }), comment('o2', {})],
      commits: [],
      reviews: [],
    })
    expect(entries.map(e => e.key)).toEqual(['thread:o1', 'thread:o2'])
  })
  it('keeps non-commented or bodied reviews and sorts missing timestamps last in input order', () => {
    const entries = remoteTimeline({
      comments: [comment('c1', { createdAt: '2024-01-01T00:00:00Z' })],
      inline: [],
      commits: [commit('k'.repeat(40))],
      reviews: [review('r1'), review('r2', { state: 'approved' })],
    })
    expect(entries.map(e => e.key)).toEqual(['comment:c1', 'commit:' + 'k'.repeat(40), 'review:r2'])
  })
  it('prefers committedAt over date for commit ordering', () => {
    const entries = remoteTimeline({
      comments: [comment('c1', { createdAt: '2024-01-02T00:00:00Z' })],
      inline: [],
      commits: [commit('a'.repeat(40), { date: '2024-01-05T00:00:00Z', committedAt: '2024-01-01T00:00:00Z' })],
      reviews: [],
    })
    expect(entries.map(e => e.key)).toEqual(['commit:' + 'a'.repeat(40), 'comment:c1'])
  })
})
