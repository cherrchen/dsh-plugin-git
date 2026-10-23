/** Portable remote sidebar: the pull/issue list. Item details open as resource tabs. */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { GitRemoteController, type GitRemoteFeature } from '../remote.ts'
import { resolveGitController, type GitSessionControllers } from '../session-controllers.ts'
import { effectiveWorkspacePath } from '../workspace-path.ts'
import { useGitWorkspace } from '../use-git-workspace.ts'
import type { RemoteRepository } from '../../remote/provider.ts'
import { IconRefreshOutline16 } from '../../compat/dsh-icons.tsx'
import { GitIconButton } from '../details/GitIconButton.tsx'
import { RemoteAuthControl } from '../remote/RemoteAuthControl.tsx'
import { RemoteContextBar, type RemoteListState } from '../remote/RemoteContextBar.tsx'
import { RemoteItemList } from '../remote/RemoteItemList.tsx'
import { RemoteCreateDialog } from '../remote/RemoteCreateDialog.tsx'
import { RemoteNotices } from '../remote/RemoteNotices.tsx'
import { RemoteLoading, RemoteListSkeleton } from '../remote/RemoteLoading.tsx'
import css from '../GitRemoteSurface.module.css'

type Props = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'git'> & {
  gitSessions: GitSessionControllers
  remoteFeature: GitRemoteFeature
  openRemoteItem: (target: RemoteRepository, kind: 'pulls' | 'issues', number: number) => void
}
export function GitRemoteSurface({ gitSessions, remoteFeature, openRemoteItem, sessionId, useSessions, t }: Props): ReactNode {
  const local = resolveGitController({ gitSessions, sessionId })
  const localState = useSyncExternalStore(local.subscribe, local.getSnapshot)
  const workspacePath = useSessions(list => effectiveWorkspacePath(list.byId[sessionId]))
  useGitWorkspace(local, workspacePath)
  const controller = useMemo(() => new GitRemoteController(remoteFeature, sessionId), [remoteFeature, sessionId])
  useEffect(() => () => controller.dispose(), [controller])
  useEffect(() => { controller.setRepository(localState.repository?.root) }, [controller, localState.repository?.root])
  const notices = useSyncExternalStore(remoteFeature.subscribe, remoteFeature.getNotices)
  useEffect(() => { const timer = setInterval(() => { void controller.pollNotices() }, 60000); return () => clearInterval(timer) }, [controller])
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const [kind, setKind] = useState<'pulls' | 'issues'>('pulls')
  const [listState, setListState] = useState<RemoteListState>('open')
  const [create, setCreate] = useState(false)
  const capability = state.capability
  const writable = state.facts?.viewer !== undefined && !state.busy && !state.unknown
  const loadingList = state.pending === 'repositories' || state.pending === 'repository' || state.pending === 'items'
  const displayedKind = state.listKind ?? kind
  if (capability.state === 'off') return <p className={css.empty}>{t('remote.unavailable')}</p>
  return <div className={css.root} data-git-remote-surface="">
    <div className={css.modeBar} data-git-remote-toolbar="">
      <div className={css.modePills}>
        <Pill active={kind === 'pulls'} disabled={state.busy} onClick={() => { setKind('pulls'); void controller.load('pulls', undefined, listState) }}>{t('remote.pulls')}</Pill>
        <Pill active={kind === 'issues'} disabled={state.busy} onClick={() => { setKind('issues'); void controller.load('issues', undefined, listState) }}>{t('remote.issues')}</Pill>
      </div>
      <RemoteAuthControl
        capability={capability}
        viewer={state.facts?.viewer}
        busy={state.busy}
        controller={controller}
        t={t}
      />
      <GitIconButton
        label={t('details.refresh')}
        disabled={state.busy}
        onClick={() => { void controller.load(kind, undefined, listState) }}
      >
        <IconRefreshOutline16 size={14} />
      </GitIconButton>
    </div>
    <RemoteNotices notices={notices} t={t} />
    <div className={css.loadingArea}>
      <RemoteLoading pending={state.pending} streaming={state.streaming} t={t} />
    </div>
    <div className={css.body}>
      <div className={css.pad}>
        {state.repository === undefined ? <p className={css.empty}>{t('details.noWorkspace')}</p> : <>
          <RemoteContextBar
            remotes={state.remotes}
            target={state.target ?? state.remotes[0]?.identity}
            listState={listState}
            busy={state.busy}
            onSelect={remote => { void controller.load(kind, remote.identity, listState) }}
            onListState={next => { setListState(next); void controller.load(kind, undefined, next) }}
            t={t}
          />
          {!state.busy && state.error === undefined && state.remotes.length === 0 && <p className={css.empty}>{t('remote.noRemote')}</p>}
          {loadingList && state.items.length === 0 ? <RemoteListSkeleton /> : (
            <RemoteItemList
              kind={displayedKind}
              items={state.items}
              busy={state.busy && !loadingList}
              writable={writable}
              onOpen={number => { if (state.target !== undefined) openRemoteItem(state.target, displayedKind, number) }}
              onCreate={() => { setCreate(true) }}
              t={t}
            />
          )}
          {!state.busy && !state.streaming && state.itemsNext === undefined && state.error === undefined && state.target !== undefined && state.items.length === 0 && <p className={css.empty}>{t('remote.noItems')}</p>}
        </>}
        {state.streamError !== undefined && <p className={css.error} role="alert">{state.streamError}</p>}
        {state.error !== undefined && <p className={css.error} role="alert">{state.error}</p>}
        {state.unknown && <p className={css.error} role="alert">{t('remote.unknown')}</p>}
      </div>
    </div>
    <RemoteCreateDialog
      open={create}
      writable={writable}
      onClose={() => { setCreate(false) }}
      onSubmit={values => {
        if (state.target === undefined) return
        void controller.write('remote-create-pr', {
          title: values.title,
          body: values.body,
          head: { ...state.target, owner: values.headOwner || state.target.owner, repo: values.headRepo || state.target.repo },
          headRef: values.headRef,
          baseRef: values.baseRef,
          draft: false,
        }).then(() => {
          if (controller.getSnapshot().error !== undefined) return
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
