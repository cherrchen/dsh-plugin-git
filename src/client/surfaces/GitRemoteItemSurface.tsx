/** Remote pull/issue detail tab: one shared body renders either kind from the tab address. */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { type GitRemoteFeature } from '../remote.ts'
import { resolveGitController, type GitSessionControllers } from '../session-controllers.ts'
import { effectiveWorkspacePath } from '../workspace-path.ts'
import { useGitWorkspace } from '../use-git-workspace.ts'
import { remoteTargetKey, remoteTargetLabel, sameRemoteTarget, type RemoteTarget } from '../remote/remote-view.ts'
import type { RemotePull, ScopedRemotePull } from '../../remote/provider.ts'
import { IconRefreshOutline16, IconRightUpOutline16 } from '../../compat/dsh-icons.tsx'
import { GitIconButton } from '../details/GitIconButton.tsx'
import { parseGitRemoteItemAddress, type GitRemoteItemPayload } from '../contract.ts'
import { RemoteAuthControl } from '../remote/RemoteAuthControl.tsx'
import { RemoteLoading } from '../remote/RemoteLoading.tsx'
import { RemoteDetailSection, remoteMarkdownLabels } from '../remote/RemoteDetailSection.tsx'
import { RemotePullActions } from '../remote/RemotePullActions.tsx'
import { RemoteTimeline } from '../remote/RemoteTimeline.tsx'
import { RemoteComposer, type RemoteReviewEvent } from '../remote/RemoteComposer.tsx'
import { RemoteBlockedGate, RemoteOutcome } from '../remote/RemoteOutcome.tsx'
import { RemoteAvatar } from '../remote/RemoteAvatar.tsx'
import css from '../GitRemoteSurface.module.css'

type Props = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'git'> & { gitSessions: GitSessionControllers; remoteFeature: GitRemoteFeature }
export function GitRemoteItemSurface({ gitSessions, remoteFeature, sessionId, useSessions, useTabInfo, t }: Props): ReactNode {
  const local = resolveGitController({ gitSessions, sessionId })
  const localState = useSyncExternalStore(local.subscribe, local.getSnapshot)
  const workspacePath = useSessions(list => effectiveWorkspacePath(list.byId[sessionId]))
  useGitWorkspace(local, workspacePath)
  const { tab } = useTabInfo()
  const { address, params, revision } = tab.navigation
  const payload = useMemo(() => {
    const opened = params as GitRemoteItemPayload | undefined
    return opened !== undefined && typeof opened.number === 'number' && (opened.kind === 'pulls' || opened.kind === 'issues')
      ? opened
      : parseGitRemoteItemAddress(address)
  }, [address, params])
  const identity = useMemo((): RemoteTarget | undefined => {
    if (payload === undefined) return undefined
    if ('provider' in payload && payload.provider === 'gitlab') return { provider: 'gitlab', instance: payload.instance, path: payload.path, scope: { provider: 'gitlab', instance: payload.instance } }
    if ('owner' in payload) return { provider: 'github', host: 'github.com', owner: payload.owner, repo: payload.repo }
    return undefined
  }, [payload])
  const controller = remoteFeature.controllerFor(sessionId, `item:${remoteTargetKey(identity)}:${payload?.kind ?? ''}:${payload?.number ?? ''}`)
  useEffect(() => { controller.setRepository(localState.repository?.root, false) }, [controller, localState.repository?.root])
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const [checkoutName, setCheckoutName] = useState('')
  const [body, setBody] = useState('')
  const detail = state.detail
  const pr = detail !== undefined && 'head' in detail ? detail as RemotePull | ScopedRemotePull : undefined
  const gitlab = state.target?.provider === 'gitlab'
  const instance = gitlab && state.target?.provider === 'gitlab' ? state.target.scope.instance : undefined
  const capability = state.scopedCapability ?? (state.capability.state === 'on' ? state.capability : undefined)
  const scopedFacts = state.facts !== undefined && 'actionScope' in state.facts ? state.facts : undefined
  useEffect(() => { setBody('') }, [state.generation?.instanceId, state.generation?.revision, state.repository, detail?.number, pr?.head.sha])
  const locked = detail?.rawState === 'locked' || detail?.state === 'unknown'
  const writable = state.facts?.viewer !== undefined && !state.busy && !state.unknown && !state.blocked && !locked
  const labels = useMemo(() => remoteMarkdownLabels(t), [t])
  const write = (endpoint: string, values: Record<string, unknown> = {}): Promise<boolean> => {
    return controller.write(endpoint, values).then(() => {
      const snapshot = controller.getSnapshot()
      if (snapshot.error !== undefined) return false
      if (endpoint === 'remote-checkout-pr' || endpoint === 'remote-issue-branch') void local.refresh()
      setBody('')
      if (detail !== undefined && !snapshot.blocked) void controller.open(detail.number, payload?.kind ?? 'pulls')
      return true
    })
  }
  const targetMatches = identity !== undefined && sameRemoteTarget(state.target, identity)
  const detailMatches = payload !== undefined && detail !== undefined && detail.number === payload.number
    && (payload.kind === 'issues' ? !('head' in detail) : 'head' in detail)
  // Each load/open is attempted once per key; a failure leaves the error visible instead of retrying in a hot loop.
  const handled = useMemo(() => ({ current: '' }), [controller])
  useEffect(() => {
    if (payload === undefined || identity === undefined || state.repository === undefined || state.busy || state.capability.state !== 'on') return
    const generation = state.capability.state === 'on' ? state.capability.generation : undefined
    const genKey = generation === undefined ? '-' : `${generation.instanceId}:${generation.revision}`
    if (!targetMatches) {
      const key = `load:${remoteTargetKey(identity)}@${state.repository}:${genKey}`
      if (handled.current !== key) { handled.current = key; void controller.ensureList(payload.kind, identity) }
      return
    }
    const key = `open:${state.repository}:${genKey}:${revision}:${payload.kind}/${payload.number}`
    if (handled.current !== key) { handled.current = key; void controller.ensureOpen(payload.number, payload.kind, revision) }
  }, [controller, handled, payload, identity, state.repository, state.busy, state.capability, targetMatches, detailMatches, revision])
  if (payload === undefined || capability === undefined) return <p className={css.empty}>{t('remote.unavailable')}</p>
  return <div className={css.root}>
    <div className={`${css.modeBar} ${css.modeBarDetail}`} data-git-remote-toolbar="">
      <span className={css.toolbarContext}>{identity === undefined ? '' : remoteTargetLabel(identity)}</span>
      <RemoteAuthControl
        capability={capability}
        viewer={state.facts?.viewer ?? capability.viewer}
        busy={state.busy}
        gitlab={gitlab}
        controller={controller}
        t={t}
      />
      <GitIconButton
        label={t('details.refresh')}
        disabled={state.busy || !targetMatches}
        onClick={() => { void controller.refresh() }}
      >
        <IconRefreshOutline16 size={14} />
      </GitIconButton>
    </div>
    <div className={`${css.loadingArea} ${css.loadingAreaDetail}`}>
      <RemoteLoading pending={state.pending} streaming={state.streaming} t={t} />
    </div>
    <div className={css.body}>
      <div className={css.detailPad}>
        {state.repository === undefined ? <p className={css.empty}>{t('details.noWorkspace')}</p> : <>
          {state.outcome !== undefined && <RemoteOutcome value={state.outcome} t={t} />}
          {state.blocked && (
            <RemoteBlockedGate
              blockedAction={state.blockedAction}
              errorDetails={state.errorDetails}
              reconciled={state.reconciled}
              busy={state.busy}
              onAcknowledge={() => { controller.acknowledgeReconciliation() }}
              t={t}
            />
          )}
          {state.unavailable.length > 0 && <p className={css.note} role="status">{t('gitlab.readUnavailable')}</p>}
          {detail !== undefined && (
            <RemoteDetailSection detail={detail} labels={labels} instance={instance} t={t}>
              {pr === undefined ? (
                <div className={css.actionsRow}>
                  <Button variant="outline" size="sm" disabled={!writable} onClick={() => { void write('remote-issue-branch') }}>
                    {t('remote.issueBranch')}
                  </Button>
                </div>
              ) : (
                <>
                  <RemotePullActions
                    pr={pr}
                    actions={state.facts?.actions}
                    writable={writable}
                    confirmation={state.confirmation}
                    mergeMethods={scopedFacts?.supportedMergeMethods}
                    checkoutName={checkoutName}
                    viewer={state.facts?.viewer?.login}
                    onCheckoutName={setCheckoutName}
                    onCheckout={() => { void write('remote-checkout-pr', checkoutName.trim() === '' ? {} : { branch: checkoutName.trim() }) }}
                    onPrepare={(action, method) => { controller.prepare(action, method) }}
                    onConfirm={() => { void controller.confirm() }}
                    onCancel={() => { controller.cancelConfirmation() }}
                    t={t}
                  />
                  {pr.url !== undefined && (
                    <div className={css.actionsRow}>
                      <a className={css.linkButton} href={`${pr.url}/${gitlab ? 'diffs' : 'files'}`} target="_blank" rel="noreferrer">
                        {t('remote.filesChanged')}
                        <IconRightUpOutline16 size={14} />
                      </a>
                    </div>
                  )}
                  {gitlab && scopedFacts !== undefined && scopedFacts.operationSupport['inline-comment'].supported !== true && (
                    <p className={css.note}>{t('gitlab.inlineDisabled')}</p>
                  )}
                  {state.approvals !== undefined && (
                    <section className={css.section} aria-label={t('gitlab.approvals')}>
                      <h3 className={css.sectionHead}>
                        <span className={css.sectionTitle}>
                          {t('gitlab.approvals')}
                          <span className={css.sectionCount}>{state.approvals.approvedBy.length}</span>
                        </span>
                        {state.approvals.approved === true && <Tag tone="success">{t('remote.reviewApproved')}</Tag>}
                      </h3>
                      {state.approvals.approvalsLeft !== undefined && state.approvals.approvalsRequired !== undefined && (
                        <p className={css.detailMeta}>{state.approvals.approvalsRequired - state.approvals.approvalsLeft}/{state.approvals.approvalsRequired}</p>
                      )}
                      <ul className={css.itemList}>
                        {state.approvals.approvedBy.map(author => (
                          <li key={author.userId} className={css.tlReplyHead}>
                            <RemoteAvatar login={author.login} url={author.avatarUrl} size={16} />
                            <strong>{author.login}</strong>
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}
                </>
              )}
              <RemoteTimeline
                comments={state.comments}
                inline={pr === undefined ? [] : state.inline}
                commits={pr === undefined ? [] : state.commits}
                reviews={pr === undefined ? [] : state.reviews}
                labels={labels}
                instance={instance}
                t={t}
              />
            </RemoteDetailSection>
          )}
          {pr !== undefined && (
            <RemoteComposer
              writable={writable}
              canComment={scopedFacts !== undefined && !scopedFacts.operationSupport.comment.supported ? false : state.facts?.actions.canComment}
              canReview={scopedFacts !== undefined && !scopedFacts.operationSupport.review.supported ? false : state.facts?.actions.canReview}
              reviewPermissions={scopedFacts?.reviewPermissions}
              events={scopedFacts?.supportedReviewEvents}
              body={body}
              onBody={setBody}
              onComment={() => { void write('remote-comment', { body }) }}
              onReview={(event: RemoteReviewEvent) => { void write('remote-review', { body, event }) }}
              t={t}
            />
          )}
          {state.checkout !== undefined && (
            <p className={css.receipt} role="status">
              {t(state.checkout.error === undefined ? 'remote.checkoutDone' : 'remote.checkoutPartial')} · {state.checkout.branch} · {state.checkout.head ?? ''}<br />
              {state.checkout.privateRefWritten ? t('remote.privateRefPrepared') : ''} {state.checkout.trackingRefPrepared ? t('remote.trackingPrepared') : ''} {state.checkout.fetchMappingAdded ? t('remote.mappingPrepared') : ''} {state.checkout.upstreamNotConfigured ? t('remote.upstreamPending') : ''}
            </p>
          )}
        </>}
        {state.streamError !== undefined && <p className={css.error} role="alert">{state.streamError}</p>}
        {state.error !== undefined && <p className={css.error} role="alert">{state.error}{state.errorDetails?.['reason'] === undefined ? '' : ` · ${String(state.errorDetails['reason'])}`}</p>}
        {state.unknown && <p className={css.error} role="alert">{t('remote.unknown')}</p>}
      </div>
    </div>
  </div>
}
