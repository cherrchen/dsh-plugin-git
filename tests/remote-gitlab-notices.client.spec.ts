import { describe, expect, it } from 'vitest'
import { GitLabNotices } from '../src/client/gitlab-notices.ts'
import type { ScopedRemoteNotice, ScopedRemotePull } from '../src/remote/provider.ts'
const sha = 'a'.repeat(40), generation = { instanceId: 'gen', revision: 1 }
const viewer = { host: 'git.example', userId: '9', login: 'alice' }
const identity = { instance: 'https://git.example', projectId: '42', viewer, generation }
const notice: ScopedRemoteNotice = { id: '11', projectId: '42', objectId: '99', number: 7, kind: 'review-requested', title: 'Review', state: 'pending', updatedAt: '2026-10-27T00:00:00Z' }
const pull: ScopedRemotePull = { id: '99', number: 7, title: 'Own MR', body: '', author: { userId: '9', login: 'alice' }, state: 'open', rawState: 'opened', draft: false, head: { projectId: '42', ref: 'topic', sha }, base: { projectId: '42', ref: 'main', sha } }
describe('GitLab notification isolation', () => {
  it('deduplicates by instance, project, viewer, generation, object and state without cross-instance collisions', () => {
    const notices = new GitLabNotices(); notices.activate(identity)
    expect(notices.add(notice)).toBe(true); expect(notices.add(notice)).toBe(false)
    notices.activate({ ...identity, instance: 'https://other.example' }); expect(notices.add(notice)).toBe(true)
    notices.activate(identity); expect(notices.items).toHaveLength(1); expect(notices.add({ ...notice, projectId: '99' })).toBe(false)
    notices.activate({ ...identity, viewer: { ...viewer, userId: '10' }, generation: { ...generation, revision: 2 } })
    expect(notices.items).toEqual([]); expect(notices.add(notice)).toBe(true)
    notices.activate({ ...identity, instance: 'https://other.example' }); expect(notices.items).toHaveLength(1)
    notices.clearInstance(identity.instance); expect(notices.items).toHaveLength(1)
    notices.clear(); expect(notices.items).toEqual([])
  })
  it('observes only loaded own MRs and never infers closed from locked or unknown states', () => {
    const notices = new GitLabNotices(); notices.activate(identity)
    expect(notices.observe({ ...pull, author: { userId: '10', login: 'other' } })).toBeUndefined()
    expect(notices.observe(pull)).toBeUndefined()
    expect(notices.observe({ ...pull, rawState: 'locked' })).toBeUndefined()
    expect(notices.observe({ ...pull, state: 'unknown', rawState: 'future' })).toBeUndefined()
    const closed = notices.observe({ ...pull, state: 'closed', rawState: 'closed', updatedAt: 'later' })
    expect(closed).toMatchObject({ kind: 'closed', id: '99', projectId: '42', state: 'closed' })
    expect(notices.observe({ ...pull, state: 'closed', rawState: 'closed', updatedAt: 'later' })).toBeUndefined()
    expect(notices.nextPull()?.number).toBe(7)
  })
})
