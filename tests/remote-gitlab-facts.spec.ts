import { describe, expect, it } from 'vitest'
import { gitLabRepositoryFacts } from '../src/remote/gitlab-facts.ts'
import { gitLabPull } from '../src/remote/gitlab-model.ts'

const instance = 'https://git.example.com', viewer = { host: 'git.example.com', userId: '9', login: 'reviewer' }
const project = { merge_requests_access_level: 'enabled', merge_method: 'merge', squash_option: 'default_off' }
const raw = { id: 100, iid: 7, title: 'MR', description: '', state: 'opened', author: null, source_project_id: 42, target_project_id: 42, source_branch: 'feature', target_branch: 'main', sha: 'a'.repeat(40), draft: false, detailed_merge_status: 'mergeable', squash_on_merge: false }
const facts = (overrides: { raw?: Record<string, unknown>; project?: Record<string, unknown>; reauth?: boolean | 'unknown'; viewer?: typeof viewer | null } = {}) => {
  const value = { ...raw, ...overrides.raw }
  return gitLabRepositoryFacts({ path: 'group/repo', projectId: '42', project: overrides.project ?? project, ...(overrides.viewer === null ? {} : { viewer: overrides.viewer ?? viewer }), object: { kind: 'pull', value: gitLabPull(value, instance, '42'), raw: value }, approvalReauthentication: overrides.reauth ?? false })
}
describe('GitLab repository and object facts', () => {
  it('separates supported operations from unknown permissions and project method policy', () => {
    const value = facts()
    expect(value).toMatchObject({ actionScope: { projectId: '42', object: { kind: 'pull', number: 7 } }, actions: { canComment: 'unknown', canReview: 'unknown', canClose: 'unknown', canMerge: 'unknown' }, operationSupport: { comment: { supported: true }, 'inline-comment': { supported: false }, 'merge-pr': { supported: true } }, supportedMergeMethods: ['merge'], supportedReviewEvents: ['COMMENT', 'APPROVE'] })
  })
  it('limits an object to the intersection of project policy and effective squash state', () => {
    const methods = (squash: string, effective: unknown) => facts({ project: { ...project, squash_option: squash }, raw: { squash_on_merge: effective } }).supportedMergeMethods
    expect(methods('never', false)).toEqual(['merge'])
    expect(methods('always', true)).toEqual(['squash'])
    expect(methods('default_on', false)).toEqual(['merge'])
    expect(methods('default_off', true)).toEqual(['squash'])
    expect(methods('never', true)).toEqual([])
    expect(methods('always', false)).toEqual([])
    expect(methods('default_off', undefined)).toEqual([])
    expect(methods('unknown', false)).toEqual([])
  })
  it('blocks locked, unknown and draft objects without mistaking them for closed', () => {
    for (const raw of [{ state: 'locked' }, { state: 'surprise' }, { draft: true }]) expect(facts({ raw }).actions.canMerge).toBe(false)
    expect(facts({ raw: { state: 'locked' } }).actions.canComment).toBe(false)
    expect(facts({ raw: { state: 'surprise' } }).actions.canClose).toBe(false)
  })
  it('keeps ordinary comments when reauthentication blocks or obscures approval', () => {
    for (const reauth of [true, 'unknown'] as const) expect(facts({ reauth }).supportedReviewEvents).toEqual(['COMMENT'])
    expect(facts({ reauth: true }).actions.canComment).toBe('unknown')
    const closed = facts({ raw: { state: 'closed' } })
    expect(closed.actions.canComment).toBe('unknown'); expect(closed.supportedReviewEvents).toEqual(['COMMENT'])
  })
  it('honors known merge permission, blockers and absent policy without inventing support', () => {
    expect(facts({ raw: { user: { can_merge: false } } }).actions.canMerge).toBe(false)
    expect(facts({ raw: { detailed_merge_status: 'ci_still_running' } }).actions.canMerge).toBe(false)
    expect(facts({ raw: { has_conflicts: true } }).actions.canMerge).toBe(false)
    expect(facts({ raw: { blocking_discussions_resolved: false } }).actions.canMerge).toBe(false)
    const noPolicy = facts({ project: { merge_requests_access_level: 'enabled' } })
    expect(noPolicy.supportedMergeMethods).toEqual([]); expect(noPolicy.operationSupport['merge-pr'].supported).toBe(false)
    expect(facts({ viewer: null }).actions.canComment).toBe(false)
  })
})
