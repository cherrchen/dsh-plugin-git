import { describe, expect, it } from 'vitest'
import { gitLabApprovals, gitLabCommit, gitLabDiscussion, gitLabFile, gitLabIssue, gitLabPull, gitLabWebUrl } from '../src/remote/gitlab-model.ts'

const instance = 'https://git.example.com/gitlab', head = 'a'.repeat(40), base = 'b'.repeat(40), start = 'c'.repeat(40)
const mr = {
  id: 1234, iid: 7, title: 'Change', description: 'Text', state: 'locked',
  author: { id: 9, username: 'reviewer', avatar_url: 'https://git.example.com/gitlab/uploads/avatar.png' },
  web_url: 'https://git.example.com/gitlab/group/project/-/merge_requests/7',
  source_project_id: 99, target_project_id: 42, source_branch: 'feature', target_branch: 'main', sha: head,
  diff_refs: { base_sha: base, start_sha: start, head_sha: head }, draft: false,
}
describe('GitLab provider projections', () => {
  it('retains global id, iid, both projects, fork refs and all supplied comparison SHAs', () => {
    expect(gitLabPull(mr, instance, '42')).toMatchObject({
      id: '1234', number: 7, state: 'open', rawState: 'locked', draft: false,
      head: { projectId: '99', ref: 'feature', sha: head }, base: { projectId: '42', ref: 'main', sha: start },
      diffRefs: { baseSha: base, startSha: start, headSha: head }, author: { userId: '9' },
    })
    expect(() => gitLabPull(mr, instance, '43')).toThrow()
    expect(gitLabPull({ ...mr, state: 'new-server-state', source_project_id: null, sha: null, draft: null }, instance, '42')).toMatchObject({ state: 'unknown', rawState: 'new-server-state', head: { projectId: null, sha: null }, draft: 'unknown' })
  })
  it('checks Issue project identity separately from object id and iid', () => {
    const issue = { id: 2000, iid: 7, project_id: 42, title: 'Issue', description: null, state: 'opened', author: null }
    expect(gitLabIssue(issue, instance, '42')).toMatchObject({ id: '2000', number: 7, state: 'open', body: '' })
    expect(() => gitLabIssue(issue, instance, '43')).toThrow()
    expect(gitLabIssue({ ...issue, state: 'unexpected' }, instance, '42')).toMatchObject({ state: 'unknown', rawState: 'unexpected' })
    expect(() => gitLabIssue({ ...issue, iid: 0 }, instance, '42')).toThrow()
  })
  it('preserves independent discussion and note ids, both sides of a diff, and its original range', () => {
    const discussion = { id: 'thread-abc', notes: [{ id: 88, body: 'Keep this', author: null, system: false, resolvable: true, resolved: false, position: { position_type: 'text', base_sha: base, start_sha: start, head_sha: head, old_path: 'old.txt', new_path: 'new.txt', old_line: 4, new_line: 5, line_range: { start: { line_code: 'abc_4_5', type: 'old', old_line: 4, new_line: 5 }, end: { line_code: 'abc_6_7', type: 'new', old_line: 6, new_line: 7 } } } }] }
    const result = gitLabDiscussion(discussion, instance)
    if (result === null) throw new Error('expected a discussion')
    expect(result).toMatchObject({ id: 'thread-abc', notes: [{ id: '88', discussionId: 'thread-abc', resolvable: true, resolved: false, position: { baseSha: base, startSha: start, headSha: head, oldPath: 'old.txt', newPath: 'new.txt', oldLine: 4, newLine: 5, lineRange: { start: { oldLine: 4, newLine: 5 }, end: { oldLine: 6, newLine: 7 } } } }] })
    expect(result.notes[0]).not.toHaveProperty('reviewId')
    expect(gitLabDiscussion({ ...discussion, individual_note: true }, instance)).toBeNull()
  })
  it('keeps approvals as current facts and does not invent review history', () => {
    const result = gitLabApprovals({ project_id: 42, iid: 7, approved_by: [{ user: { id: 9, username: 'reviewer' } }], approvals_required: 2, approvals_left: 1 }, instance, '42', 7)
    expect(result).toEqual({ approvedBy: [{ userId: '9', login: 'reviewer' }], approvalsRequired: 2, approvalsLeft: 1 })
    expect(result).not.toHaveProperty('approved')
    expect(() => gitLabApprovals({ project_id: 43, iid: 7, approved_by: [] }, instance, '42', 7)).toThrow()
    expect(gitLabCommit({ id: head, title: 'Commit', author_name: 'Author', author_email: 'private@example.test' }, instance)).toEqual({ sha: head, subject: 'Commit', authorName: 'Author' })
  })
  it('does not claim an empty upstream diff is a complete patch', () => {
    expect(gitLabFile({ old_path: 'a', new_path: 'a', new_file: false, deleted_file: false, renamed_file: false, diff: '' })).toEqual({ oldPath: 'a', newPath: 'a', status: 'modified', content: 'unavailable' })
  })
  it.each([
    'https://evil.example/gitlab/group/repo', 'https://git.example.com/other/group/repo',
    'http://git.example.com/gitlab/group/repo', 'https://user:secret@git.example.com/gitlab/group/repo',
    'https://git.example.com/gitlab/group/%2e%2e/secret', 'https://git.example.com/gitlab/group/%252fsecret',
    'https://git.example.com/gitlab/group%2frepo', 'https://git.example.com/gitlab/group/repo?access_token=secret',
    'javascript:alert(1)',
  ])('drops an unsafe browser URL %s', value => expect(gitLabWebUrl(instance, value)).toBeUndefined())
  it('uses a separate narrow policy for avatars and permits a same-instance note fragment', () => {
    expect(gitLabWebUrl(instance, `${instance}/group/repo/-/issues/7#note_12`)).toBe(`${instance}/group/repo/-/issues/7#note_12`)
    expect(gitLabWebUrl(instance, 'https://secure.gravatar.com/avatar/hash?s=80', true)).toBe('https://secure.gravatar.com/avatar/hash?s=80')
    expect(gitLabWebUrl(instance, 'https://secure.gravatar.com/avatar/hash?s=80&d=identicon', true)).toBe('https://secure.gravatar.com/avatar/hash?s=80&d=identicon')
    expect(gitLabWebUrl(instance, 'https://secure.gravatar.com/avatar/hash?s=80&s=90', true)).toBeUndefined()
    expect(gitLabWebUrl(instance, 'https://secure.gravatar.com/avatar/hash?d=https%3A%2F%2Fevil.example', true)).toBeUndefined()
    expect(gitLabWebUrl(instance, 'https://secure.gravatar.com/avatar/hash?s=80')).toBeUndefined()
  })
})
