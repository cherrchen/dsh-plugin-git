/** Per-instance/project notification state. No natural-language event inference. */
import type { ScopedRemoteNotice, ScopedRemotePull } from '../remote/provider.ts'
import type { GitRemoteGeneration, GitRemoteViewer } from '../remote/types.ts'
interface Identity { readonly instance: string; readonly projectId: string; readonly viewer: GitRemoteViewer; readonly generation: GitRemoteGeneration }
interface Bucket { readonly identity: Identity; readonly seen: Set<string>; readonly notices: ScopedRemoteNotice[]; readonly tracked: Map<string, ScopedRemotePull>; nextTracked: number; cursor?: string | undefined }
export class GitLabNotices {
  private readonly buckets = new Map<string, Bucket>()
  private current: Bucket | undefined
  activate(identity: Identity): void {
    for (const [key, bucket] of this.buckets) {
      const old = bucket.identity
      if (old.instance === identity.instance && (old.viewer.host !== identity.viewer.host || old.viewer.userId !== identity.viewer.userId || old.generation.instanceId !== identity.generation.instanceId || old.generation.revision !== identity.generation.revision)) this.buckets.delete(key)
    }
    const key = JSON.stringify([identity.instance, identity.projectId, identity.viewer.host, identity.viewer.userId, identity.generation])
    let bucket = this.buckets.get(key)
    if (bucket === undefined) { bucket = { identity, seen: new Set(), notices: [], tracked: new Map(), nextTracked: 0 }; this.buckets.set(key, bucket) }
    this.current = bucket
  }
  clear(): void { this.buckets.clear(); this.current = undefined }
  clearInstance(instance: string): void { for (const [key, bucket] of this.buckets) if (bucket.identity.instance === instance) this.buckets.delete(key); if (this.current?.identity.instance === instance) this.current = undefined }
  deactivate(): void { this.current = undefined }
  get items(): readonly ScopedRemoteNotice[] { return this.current?.notices ?? [] }
  get cursor(): string | undefined { return this.current?.cursor }
  set cursor(value: string | undefined) { if (this.current !== undefined) this.current.cursor = value }
  add(notice: ScopedRemoteNotice): boolean {
    const bucket = this.current
    if (bucket === undefined || notice.projectId !== bucket.identity.projectId) return false
    const key = JSON.stringify([bucket.identity.instance, notice.projectId, bucket.identity.viewer.userId, bucket.identity.generation, notice.kind, notice.id, notice.state, notice.updatedAt ?? ''])
    if (bucket.seen.has(key)) return false
    bucket.seen.add(key); bucket.notices.push(notice)
    // Display history is bounded; deduplication keys remain for the lifetime of the context.
    if (bucket.notices.length > 100) bucket.notices.shift()
    return true
  }
  observe(pull: ScopedRemotePull): ScopedRemoteNotice | undefined {
    const bucket = this.current
    if (bucket === undefined || pull.author?.userId !== bucket.identity.viewer.userId || pull.base.projectId !== bucket.identity.projectId || pull.state === 'unknown' || pull.rawState === 'locked') return undefined
    const old = bucket.tracked.get(pull.id); bucket.tracked.set(pull.id, pull)
    if (old === undefined || old.number !== pull.number || old.state === pull.state || (pull.state !== 'closed' && pull.state !== 'merged')) return undefined
    return { id: pull.id, projectId: bucket.identity.projectId, objectId: pull.id, number: pull.number, kind: pull.state, title: pull.title, state: pull.state, ...(pull.updatedAt === undefined ? {} : { updatedAt: pull.updatedAt }), ...(pull.url === undefined ? {} : { url: pull.url }) }
  }
  nextPull(): ScopedRemotePull | undefined {
    const bucket = this.current
    if (bucket === undefined || bucket.tracked.size === 0) return undefined
    const tracked = [...bucket.tracked.values()]; const next = tracked[bucket.nextTracked % tracked.length]; bucket.nextTracked = (bucket.nextTracked + 1) % tracked.length; return next
  }
}
