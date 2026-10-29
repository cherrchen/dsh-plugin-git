/** Portable remote sidebar: the pull/issue list. Item details open as resource tabs. */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { type GitRemoteFeature } from '../remote.ts'
import { resolveGitController, type GitSessionControllers } from '../session-controllers.ts'
import { effectiveWorkspacePath } from '../workspace-path.ts'
import { useGitWorkspace } from '../use-git-workspace.ts'
import type { RemoteTarget } from '../remote/remote-view.ts'
import { IconRefreshOutline16 } from '../../compat/dsh-icons.tsx'
import { GitIconButton } from '../details/GitIconButton.tsx'
import { RemoteAuthControl } from '../remote/RemoteAuthControl.tsx'
import { RemoteContextBar, type RemoteListState } from '../remote/RemoteContextBar.tsx'
import { RemoteItemList } from '../remote/RemoteItemList.tsx'
import { RemoteCreateDialog } from '../remote/RemoteCreateDialog.tsx'
import { RemoteNotices } from '../remote/RemoteNotices.tsx'
import { RemoteLoading, RemoteListSkeleton } from '../remote/RemoteLoading.tsx'
import { RemoteBlockedToast, RemoteOutcomeToast } from '../remote/RemoteOutcome.tsx'
import { describeRemoteError, ErrorToast, useErrorToast } from '../error-feedback.tsx'
import css from '../GitRemoteSurface.module.css'

type Props = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'git'> & {
  gitSessions: GitSessionControllers
  remoteFeature: GitRemoteFeature
  openRemoteItem: (target: RemoteTarget, kind: 'pulls' | 'issues', number: number) => void
}
export function GitRemoteSurface({ gitSessions, remoteFeature, openRemoteItem, sessionId, useSessions, t }: Props): ReactNode {
  const local = resolveGitController({ gitSessions, sessionId })
  const localState = useSyncExternalStore(local.subscribe, local.getSnapshot)
  const workspacePath = useSessions(list => effectiveWorkspacePath(list.byId[sessionId]))
  useGitWorkspace(local, workspacePath)
  const controller = remoteFeature.controllerFor(sessionId)
  useEffect(() => { controller.setRepository(localState.repository?.root, false) }, [controller, localState.repository?.root])
  const notices = useSyncExternalStore(remoteFeature.subscribe, remoteFeature.getNotices)
  useEffect(() => { const timer = setInterval(() => { void controller.pollNotices() }, 60000); return () => clearInterval(timer) }, [controller])
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const errorToast = useErrorToast(state.blocked ? undefined : state.error)
  const streamToast = useErrorToast(state.streamError)
  const [kind, setKind] = useState<'pulls' | 'issues'>(state.listKind ?? 'pulls')
  const [listState, setListState] = useState<RemoteListState>(state.listState ?? 'open')
  useEffect(() => { void controller.ensureList(kind, undefined, listState) }, [controller, kind, listState, state.repository, state.capability.state, state.capability.state === 'on' ? state.capability.generation.instanceId : undefined, state.capability.state === 'on' ? state.capability.generation.revision : undefined])
  const [create, setCreate] = useState(false)
  const target = state.target
  const gitlab = target?.provider === 'gitlab'
  // The scoped target carries its own per-scope capability (GitLab instance auth).
  const capability = state.scopedCapability ?? (state.capability.state === 'on' ? state.capability : undefined)
  const scopedFacts = state.facts !== undefined && 'actionScope' in state.facts ? state.facts : undefined
  const canCreate = scopedFacts === undefined ? state.facts?.actions.canCreatePr : scopedFacts.operationSupport['create-pr'].supported ? scopedFacts.actions.canCreatePr : false
  const writable = state.facts?.viewer !== undefined && !state.busy && !state.unknown && !state.blocked
  const loadingList = state.pending === 'repositories' || state.pending === 'repository' || state.pending === 'items'
  const displayedKind = state.listKind ?? kind
  const gitlabSources = target?.provider === 'gitlab' ? state.remotes.map(remote => remote.identity).filter((identity): identity is RemoteTarget & { readonly provider: 'gitlab' } => identity.provider === 'gitlab' && identity.scope.instance === target.scope.instance) : undefined
  if (state.capability.state === 'off' && state.scopedCapability === undefined) return <div className={css.root}><p className={css.empty}>{t('remote.unavailable')}</p></div>
  return <div className={css.root} data-git-remote-surface="">
    <div className={css.modeBar} data-git-remote-toolbar="">
      <div className={css.modePills}>
        <Pill active={displayedKind === 'pulls'} disabled={state.busy} onClick={() => { setKind('pulls'); void controller.ensureList('pulls', undefined, listState) }}>{t(gitlab ? 'gitlab.mergeRequests' : 'remote.pulls')}</Pill>
        <Pill active={displayedKind === 'issues'} disabled={state.busy} onClick={() => { setKind('issues'); void controller.ensureList('issues', undefined, listState) }}>{t('remote.issues')}</Pill>
      </div>
      {capability !== undefined && (
        <RemoteAuthControl
          capability={capability}
          viewer={state.facts?.viewer ?? capability.viewer}
          busy={state.busy}
          gitlab={gitlab}
          controller={controller}
          t={t}
        />
      )}
      <GitIconButton
        label={t('details.refresh')}
        disabled={state.busy}
        onClick={() => { void controller.refresh() }}
      >
        <IconRefreshOutline16 size={14} />
      </GitIconButton>
    </div>
    <RemoteNotices notices={notices} t={t} />
    <div className={css.loadingArea}>
      <RemoteLoading pending={state.pending} streaming={state.streaming} provider={(target ?? state.remotes[0]?.identity)?.provider} t={t} />
    </div>
    <div className={css.body}>
      <div className={css.pad}>
        {state.outcome !== undefined && state.outcome.outcome === 'succeeded' && <RemoteOutcomeToast outcome={state.outcome} action={state.outcomeAction} seq={state.outcomeSeq} onDone={() => { controller.dismissOutcome() }} t={t} />}
        {state.blocked && (
          <RemoteBlockedToast
            outcome={state.outcome}
            action={state.blockedAction}
            error={state.error}
            errorDetails={state.errorDetails}
            provider={target?.provider}
            reconciled={state.reconciled}
            seq={state.outcomeSeq}
            onAcknowledge={() => { controller.acknowledgeReconciliation() }}
            t={t}
          />
        )}
        {state.repository === undefined ? <p className={css.empty}>{t('details.noWorkspace')}</p> : <>
          <RemoteContextBar
            remotes={state.remotes}
            target={state.target ?? state.remotes[0]?.identity}
            listState={listState}
            busy={state.busy}
            onSelect={remote => { void controller.ensureList(kind, remote.identity, listState) }}
            onListState={next => { setListState(next); void controller.ensureList(kind, undefined, next) }}
            t={t}
          />
          {state.unresolved.map(remote => (
            <p key={remote.name} className={css.note} role="status">
              {remote.name} · {t(remote.reason === 'ambiguous' ? 'gitlab.ambiguous' : 'gitlab.unregistered')}
            </p>
          ))}
          {!state.busy && state.error === undefined && state.remotes.length === 0 && state.unresolved.length === 0 && state.discovery === 'no-remotes' && <p className={css.empty}>{t('remote.noRemote')}</p>}
          {!state.busy && state.error === undefined && state.remotes.length === 0 && state.discovery === 'unsupported' && <p className={css.empty}>{t('remote.unsupported')}</p>}
          {loadingList && state.items.length === 0 ? <RemoteListSkeleton /> : (
            <RemoteItemList
              kind={displayedKind}
              items={state.items}
              busy={state.busy && !loadingList}
              writable={writable}
              canCreate={canCreate === false ? false : undefined}
              pullsLabel={gitlab ? 'gitlab.mergeRequests' : 'remote.pulls'}
              onOpen={number => { if (state.target !== undefined) openRemoteItem(state.target, displayedKind, number) }}
              onCreate={() => { setCreate(true) }}
              t={t}
            />
          )}
          {!state.busy && !state.streaming && state.itemsNext === undefined && state.error === undefined && state.target !== undefined && state.items.length === 0 && <p className={css.empty}>{t('remote.noItems')}</p>}
        </>}
        {streamToast.active && state.streamError !== undefined && <ErrorToast key={`s${streamToast.seq}`} report={describeRemoteError(state.streamError, undefined, target?.provider, t)} onDone={streamToast.dismiss} t={t} />}
        {errorToast.active && capability === undefined && state.error !== undefined && !state.blocked && <ErrorToast key={errorToast.seq} report={describeRemoteError(state.error, state.errorDetails, target?.provider, t)} onDone={errorToast.dismiss} t={t} />}
        {state.unknown && <ErrorToast report={describeRemoteError('git/write-result-unknown', state.errorDetails, target?.provider, t)} holdMs={Infinity} onDone={() => undefined} t={t} />}
      </div>
    </div>
    <RemoteCreateDialog
      open={create}
      writable={writable}
      gitlabSources={gitlabSources}
      onClose={() => { setCreate(false) }}
      onSubmit={values => {
        void controller.createPr(values).then(() => {
          const snapshot = controller.getSnapshot()
          if (snapshot.error !== undefined || snapshot.blocked) return
          setCreate(false)
          void controller.load(kind, undefined, listState)
        })
      }}
      t={t}
    />
  </div>
}

export function GitRemoteTitle({ t, remoteFeature }: PropsLocale<'git'> & { remoteFeature: GitRemoteFeature }): ReactNode {
  const notices = useSyncExternalStore(remoteFeature.subscribe, remoteFeature.getNotices)
  return <span>{t('remote.title')}{notices.length === 0 ? '' : ` (${notices.length})`}</span>
}
