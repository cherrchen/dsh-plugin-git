/** Remote pull/issue detail tab: one shared body renders either kind from the tab address. */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { type GitRemoteFeature } from '../remote.ts'
import { resolveGitController, type GitSessionControllers } from '../session-controllers.ts'
import { effectiveWorkspacePath } from '../workspace-path.ts'
import { useGitWorkspace } from '../use-git-workspace.ts'
import { sameRepository } from '../../remote/git.ts'
import type { RemotePull, RemoteRepository } from '../../remote/provider.ts'
import { IconRefreshOutline16, IconRightUpOutline16 } from '../../compat/dsh-icons.tsx'
import { GitIconButton } from '../details/GitIconButton.tsx'
import { parseGitRemoteItemAddress, type GitRemoteItemPayload } from '../contract.ts'
import { RemoteAuthControl } from '../remote/RemoteAuthControl.tsx'
import { RemoteLoading } from '../remote/RemoteLoading.tsx'
import { RemoteCommentCard, RemoteDetailSection, remoteMarkdownLabels } from '../remote/RemoteDetailSection.tsx'
import { RemotePullActions, type RemoteConfirmKind } from '../remote/RemotePullActions.tsx'
import { RemotePullHistory } from '../remote/RemotePullHistory.tsx'
import { RemoteComposer, type RemoteReviewEvent } from '../remote/RemoteComposer.tsx'
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
  const identity = useMemo((): RemoteRepository | undefined =>
    payload === undefined ? undefined : { provider: 'github', host: 'github.com', owner: payload.owner, repo: payload.repo }, [payload])
  const controller = remoteFeature.controllerFor(sessionId, JSON.stringify(['item', identity?.owner.toLowerCase(), identity?.repo.toLowerCase(), payload?.kind, payload?.number]))
  useEffect(() => { controller.setRepository(localState.repository?.root, false) }, [controller, localState.repository?.root])
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const [checkoutName, setCheckoutName] = useState('')
  const [body, setBody] = useState('')
  const [confirm, setConfirm] = useState<RemoteConfirmKind>()
  const detail = state.detail
  const pr = detail !== undefined && 'head' in detail ? detail as RemotePull : undefined
  const capability = state.capability
  useEffect(() => { setConfirm(undefined); setBody('') }, [state.generation?.instanceId, state.generation?.revision, state.repository, detail?.number, pr?.head.sha])
  const writable = state.facts?.viewer !== undefined && !state.busy && !state.unknown
  const labels = useMemo(() => remoteMarkdownLabels(t), [t])
  const write = (endpoint: string, values: Record<string, unknown> = {}): Promise<boolean> => {
    return controller.write(endpoint, { number: detail?.number, expectedHeadSha: pr?.head.sha, ...values }).then(() => {
      if (controller.getSnapshot().error !== undefined) return false
      if (endpoint === 'remote-checkout-pr' || endpoint === 'remote-issue-branch') void local.refresh()
      setConfirm(undefined); setBody('')
      if (detail !== undefined) void controller.open(detail.number, payload?.kind ?? 'pulls')
      return true
    })
  }
  const targetMatches = identity !== undefined && state.target !== undefined && sameRepository(state.target, identity)
  const detailMatches = payload !== undefined && detail !== undefined && detail.number === payload.number
    && (payload.kind === 'issues' ? !('head' in detail) : 'head' in detail)
  // Each load/open is attempted once per key; a failure leaves the error visible instead of retrying in a hot loop.
  const handled = useMemo(() => ({ current: '' }), [controller])
  useEffect(() => {
    if (payload === undefined || identity === undefined || state.repository === undefined || state.busy || capability.state !== 'on') return
    const generation = capability.generation
    const genKey = generation === undefined ? '-' : `${generation.instanceId}:${generation.revision}`
    if (!targetMatches) {
      const key = `load:${identity.host}/${identity.owner}/${identity.repo}@${state.repository}:${genKey}`
      if (handled.current !== key) { handled.current = key; void controller.ensureList(payload.kind, identity) }
      return
    }
    const key = `open:${state.repository}:${genKey}:${revision}:${payload.kind}/${payload.number}`
    if (handled.current !== key) { handled.current = key; void controller.ensureOpen(payload.number, payload.kind, revision) }
  }, [controller, handled, payload, identity, state.repository, state.busy, capability, targetMatches, detailMatches, revision])
  if (capability.state === 'off' || payload === undefined) return <p className={css.empty}>{t('remote.unavailable')}</p>
  return <div className={css.root}>
    <div className={css.modeBar} data-git-remote-toolbar="">
      <span className={css.toolbarContext}>{payload.owner}/{payload.repo}</span>
      <RemoteAuthControl
        capability={capability}
        viewer={state.facts?.viewer}
        busy={state.busy}
        controller={controller}
        t={t}
      />
      <GitIconButton
        label={t('details.refresh')}
        disabled={state.busy || !targetMatches}
        onClick={() => { void controller.open(payload.number, payload.kind) }}
      >
        <IconRefreshOutline16 size={14} />
      </GitIconButton>
    </div>
    <div className={css.loadingArea}>
      <RemoteLoading pending={state.pending} streaming={state.streaming} t={t} />
    </div>
    <div className={css.body}>
      <div className={css.pad}>
        {state.repository === undefined ? <p className={css.empty}>{t('details.noWorkspace')}</p> : <>
          {detail !== undefined && (
            <RemoteDetailSection detail={detail} labels={labels} t={t}>
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
                    confirm={confirm}
                    checkoutName={checkoutName}
                    viewer={state.facts?.viewer?.login}
                    onCheckoutName={setCheckoutName}
                    onCheckout={() => { void write('remote-checkout-pr', checkoutName.trim() === '' ? {} : { branch: checkoutName.trim() }) }}
                    onRequest={setConfirm}
                    onConfirm={() => { if (confirm !== undefined) void write(confirm) }}
                    onCancel={() => { setConfirm(undefined) }}
                    t={t}
                  />
                  {pr.url !== undefined && (
                    <div className={css.actionsRow}>
                      <a className={css.linkButton} href={`${pr.url}/files`} target="_blank" rel="noreferrer">
                        {t('remote.filesChanged')}
                        <IconRightUpOutline16 size={14} />
                      </a>
                    </div>
                  )}
                </>
              )}
              {state.comments.length > 0 && (
                <section className={css.section} aria-label={t('remote.comments')}>
                  <h3 className={css.sectionHead}>
                    <span className={css.sectionTitle}>
                      {t('remote.comments')}
                      <span className={css.sectionCount}>{state.comments.length}</span>
                    </span>
                  </h3>
                  {state.comments.map(comment => (
                    <RemoteCommentCard key={comment.id} comment={comment} labels={labels} />
                  ))}
                </section>
              )}
              {pr !== undefined && (
                <RemotePullHistory
                  commits={state.commits}
                  reviews={state.reviews}
                  inline={state.inline}
                  labels={labels}
                  t={t}
                />
              )}
            </RemoteDetailSection>
          )}
          {pr !== undefined && (
            <RemoteComposer
              writable={writable}
              canComment={state.facts?.actions.canComment}
              canReview={state.facts?.actions.canReview}
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
        {state.error !== undefined && <p className={css.error} role="alert">{state.error}</p>}
        {state.unknown && <p className={css.error} role="alert">{t('remote.unknown')}</p>}
      </div>
    </div>
  </div>
}
