/** GitLab-specific ref identity; local checkout mechanics live in the shared Git executor. */
import { createHash } from 'node:crypto'
import { GitRemoteError } from './errors.ts'
import { canonicalGitLabInstance } from './instance-url.ts'

export function gitLabPrivateRef(instance: string, projectId: string, number: number): string {
  if (canonicalGitLabInstance(instance) !== instance || !/^[1-9][0-9]{0,39}$/u.test(projectId) || !Number.isSafeInteger(number) || number < 1) throw new GitRemoteError('git/remote-unavailable', 'git-remote: invalid GitLab ref identity')
  const identity = createHash('sha256').update(JSON.stringify([instance, projectId])).digest('hex')
  return `refs/dsh-git-remote/mr/${identity}/${number}`
}
