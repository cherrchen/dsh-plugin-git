/** One local Git error banner per controller, shared by all mounted surfaces. */
import { useCallback, useLayoutEffect, useMemo, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { GitClientController } from './controller.ts'
import { describeLocalError, ErrorToast } from './error-feedback.tsx'
import type { GitLocaleKey } from './locales.ts'

const operationKeys: Readonly<Record<string, GitLocaleKey>> = {
  status: 'error.local.readRepository', commit: 'error.local.commitFailed',
  'switch-branch': 'error.local.switchBranch', 'create-branch': 'error.local.createBranch',
  'set-directory': 'error.local.enterWorktree', stage: 'error.local.stage', unstage: 'error.local.unstage',
  discard: 'error.local.discard', push: 'error.local.push', sync: 'error.local.sync',
}
export function localErrorKey(operation: string | undefined): GitLocaleKey {
  return operationKeys[operation ?? ''] ?? 'error.local.operationFailed'
}

class ErrorPresentation {
  private readonly listeners = new Map<symbol, () => void>()
  private state: { owner: symbol | undefined; source: string | undefined; revision?: number | undefined; visible: boolean; seq: number } = { owner: undefined, source: undefined, visible: false, seq: 0 }
  readonly getSnapshot = () => this.state
  private patch(value: Partial<typeof this.state>): void {
    this.state = { ...this.state, ...value }
    for (const listener of this.listeners.values()) listener()
  }
  subscribe(owner: symbol, listener: () => void): () => void {
    this.listeners.set(owner, listener)
    if (this.state.owner === undefined) this.patch({ owner })
    return () => {
      this.listeners.delete(owner)
      if (this.state.owner === owner) this.patch({ owner: this.listeners.keys().next().value })
    }
  }
  observe(source: string | undefined, revision: number | undefined): void {
    if (source !== this.state.source || revision !== this.state.revision) this.patch({ source, revision, visible: source !== undefined, seq: this.state.seq + 1 })
  }
  dismiss(seq: number): void { if (seq === this.state.seq) this.patch({ visible: false }) }
}
const presentations = new WeakMap<GitClientController, ErrorPresentation>()

/** A mounted surface may take over if its peer unmounts; dismissing hides the shared event everywhere. */
export function LocalGitErrorToast({ controller, t }: { readonly controller: GitClientController; readonly t: (key: GitLocaleKey) => string }): ReactNode {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const presentation = useMemo(() => {
    let current = presentations.get(controller)
    if (current === undefined) { current = new ErrorPresentation(); presentations.set(controller, current) }
    return current
  }, [controller])
  const owner = useMemo(() => Symbol('local-git-error'), [controller])
  const subscribe = useCallback((listener: () => void) => presentation.subscribe(owner, listener), [presentation, owner])
  const notice = useSyncExternalStore(subscribe, presentation.getSnapshot)
  useLayoutEffect(() => { presentation.observe(state.error, state.errorSequence) }, [presentation, state.error, state.errorSequence])
  if (notice.owner !== owner || !notice.visible || notice.source !== state.error || notice.revision !== state.errorSequence || state.error === undefined) return null
  return <ErrorToast key={notice.seq} report={describeLocalError(localErrorKey(state.errorOperation), state.error, t)} onDone={() => { presentation.dismiss(notice.seq) }} t={t} />
}
