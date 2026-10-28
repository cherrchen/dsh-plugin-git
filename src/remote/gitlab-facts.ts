/** Separate implementation support, project policy, and viewer-specific action facts. */
import type { ScopedRemoteIssue, ScopedRemotePull, ScopedRemoteRepositoryFacts, ScopedOperationSupport } from './provider.ts'
import type { GitRemoteActionAvailability, GitRemoteViewer } from './types.ts'

type ObjectFacts = { readonly kind: 'pull'; readonly value: ScopedRemotePull; readonly raw: Record<string, unknown> } | { readonly kind: 'issue'; readonly value: ScopedRemoteIssue; readonly raw: Record<string, unknown> }
function support(value: boolean, reason = 'not-implemented'): ScopedOperationSupport { return value ? { supported: true } : { supported: false, reason } }
function object(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined }

export function gitLabRepositoryFacts(input: { path: string; projectId: string; project: Record<string, unknown>; viewer?: GitRemoteViewer; object?: ObjectFacts; approvalReauthentication: boolean | 'unknown'; approvalPermission?: boolean | 'unknown' }): ScopedRemoteRepositoryFacts {
  const enabled = ['enabled', 'private', 'public'].includes(String(input.project['merge_requests_access_level']))
  const pull = input.object?.kind === 'pull' ? input.object : undefined
  const issue = input.object?.kind === 'issue'
  const readablePull = pull !== undefined && pull.value.rawState !== 'locked' && pull.value.state !== 'unknown'
  const openPull = readablePull && pull.value.state === 'open'
  const canUsePull = enabled && !issue
  const implementation = canUsePull && (input.object === undefined || readablePull)
  const mergeMethod = input.project['merge_method'], squash = input.project['squash_option']
  const mergeMethods: ('merge' | 'squash')[] = []
  if (canUsePull && ['merge', 'rebase_merge', 'ff'].includes(String(mergeMethod))) {
    // Project policy alone does not prove the effective policy of a particular
    // target branch. On an MR, only offer its current effective REST setting.
    const effective = pull?.raw['squash_on_merge']
    const objectAllows = (value: boolean) => pull === undefined || effective === value
    if (['never', 'default_on', 'default_off'].includes(String(squash)) && objectAllows(false)) mergeMethods.push('merge')
    if (['always', 'default_on', 'default_off'].includes(String(squash)) && objectAllows(true)) mergeMethods.push('squash')
  }
  const reviewEvents: ('COMMENT' | 'APPROVE')[] = implementation ? ['COMMENT'] : []
  if (implementation && (input.object === undefined || openPull) && input.approvalReauthentication === false) reviewEvents.push('APPROVE')
  const auth = input.viewer !== undefined
  const access: GitRemoteActionAvailability = auth ? 'unknown' : false
  const blocked = pull !== undefined && (!openPull || pull.value.draft !== false || pull.raw['has_conflicts'] === true || pull.raw['blocking_discussions_resolved'] === false || (typeof pull.raw['merge_error'] === 'string' && pull.raw['merge_error'] !== ''))
  const status = pull?.raw['detailed_merge_status']
  const mergeable = pull !== undefined && status === 'mergeable'
  const user = object(pull?.raw['user'])
  const mergePermission: GitRemoteActionAvailability = typeof user?.['can_merge'] === 'boolean' ? user['can_merge'] : access
  const mergeAction: GitRemoteActionAvailability = !auth || !mergeMethods.length || blocked || (pull !== undefined && !mergeable) ? false : mergePermission
  return {
    actionScope: { path: input.path, projectId: input.projectId, ...(input.object === undefined ? {} : { object: { kind: input.object.kind, number: input.object.value.number } }) },
    ...(input.viewer === undefined ? {} : { viewer: input.viewer }), permissions: {},
    actions: {
      canComment: implementation ? access : false,
      canReview: implementation && reviewEvents.length > 0 ? access : false,
      canClose: implementation && (input.object === undefined || openPull) ? access : false,
      canMerge: mergeAction,
      canCreatePr: enabled && input.object === undefined ? access : false,
    },
    operationSupport: {
      comment: support(implementation, issue ? 'issue-write-not-implemented' : enabled ? 'object-read-only' : 'capability-pending'),
      'inline-comment': support(false),
      review: support(implementation, issue ? 'issue-write-not-implemented' : enabled ? 'object-read-only' : 'capability-pending'),
      'close-pr': support(implementation, issue ? 'issue-write-not-implemented' : enabled ? 'object-read-only' : 'capability-pending'),
      'merge-pr': support(implementation && mergeMethods.length > 0, enabled ? 'project-policy-unavailable' : 'capability-pending'),
      'create-pr': support(enabled && input.object === undefined, enabled ? 'object-scope' : 'capability-pending'),
    },
    supportedMergeMethods: mergeMethods,
    supportedReviewEvents: reviewEvents,
    reviewPermissions: { COMMENT: implementation ? access : false, APPROVE: reviewEvents.includes('APPROVE') && auth ? input.approvalPermission ?? 'unknown' : false, REQUEST_CHANGES: false },
  }
}
