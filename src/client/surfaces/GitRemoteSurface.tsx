/** Portable remote sidebar. Every write uses the controller's checked generation/viewer snapshot. */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { GitRemoteController, remoteNoticeKeys, type GitRemoteFeature } from '../remote.ts'
import { resolveGitController, type GitSessionControllers } from '../session-controllers.ts'
import { effectiveWorkspacePath } from '../workspace-path.ts'
import { useGitWorkspace } from '../use-git-workspace.ts'
import { remoteDiff, validRange, type RemoteDiffAnchor } from '../../remote/diff.ts'
import type { RemotePull } from '../../remote/provider.ts'
import css from '../GitDetailsSurface.module.css'

type Props = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'git'> & { gitSessions: GitSessionControllers; remoteFeature: GitRemoteFeature }
export function GitRemoteSurface({ gitSessions, remoteFeature, sessionId, useSessions, t }: Props): ReactNode {
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
  const [listState, setListState] = useState<'open' | 'closed' | 'all'>('open')
  const [checkoutName, setCheckoutName] = useState('')
  const [body, setBody] = useState('')
  const [confirm, setConfirm] = useState<'remote-close-pr' | 'remote-merge-pr'>()
  const [anchor, setAnchor] = useState<RemoteDiffAnchor>()
  const [startAnchor, setStartAnchor] = useState<RemoteDiffAnchor>()
  const [login, setLogin] = useState<{ userCode: string; verificationUri: string; attemptId: string }>()
  const [create, setCreate] = useState(false)
  const [title, setTitle] = useState('')
  const [headOwner, setHeadOwner] = useState('')
  const [headRepo, setHeadRepo] = useState('')
  const [headRef, setHeadRef] = useState('')
  const [baseRef, setBaseRef] = useState('main')
  const detail = state.detail
  const pr = detail !== undefined && 'head' in detail ? detail as RemotePull : undefined
  const capability = state.capability
  useEffect(() => { setConfirm(undefined); setAnchor(undefined); setStartAnchor(undefined); setBody('') }, [state.generation?.instanceId, state.generation?.revision, state.repository, detail?.number, pr?.head.sha])
  const writable = state.facts?.viewer !== undefined && !state.busy && !state.unknown
  const write = (endpoint: string, values: Record<string, unknown> = {}): void => {
    void controller.write(endpoint, { number: detail?.number, expectedHeadSha: pr?.head.sha, ...values }).then(() => { if (controller.getSnapshot().error !== undefined) return; if (endpoint === 'remote-checkout-pr' || endpoint === 'remote-issue-branch') void local.refresh(); setConfirm(undefined); setBody(''); if (detail !== undefined && endpoint !== 'remote-create-pr') void controller.open(detail.number, kind); else void controller.load(kind, undefined, listState) })
  }
  if (capability.state === 'off') return <p className={css.empty}>{t('remote.unavailable')}</p>
  return <div className={css.root} data-git-remote-surface=""><div className={css.body}>
    <h3>{t('remote.title')} {notices.length > 0 ? `(${notices.length})` : ''}</h3>
    {notices.map(notice => <p key={notice.id}>{t(remoteNoticeKeys[notice.kind])} · {notice.title}</p>)}
    <p>{t('remote.auth')}: {capability.auth.state}{state.facts?.viewer === undefined ? '' : ` · ${state.facts.viewer.login}`}</p>
    <p>{t('remote.transportHint')}</p>
    <div>
      <button disabled={state.busy} onClick={() => { void controller.authAction('remote-retry-auth') }}>{t('remote.retry')}</button>
      {capability.loginAvailable && <button disabled={state.busy} onClick={() => { void controller.login(setLogin).finally(() => setLogin(undefined)) }}>{t('remote.login')}</button>}
      <button disabled={state.busy} onClick={() => { void controller.authAction('remote-use-git-credential') }}>{t('remote.useGitCredential')}</button>
      <button onClick={() => { void controller.authAction('remote-sign-out') }}>{t('remote.signOut')}</button>
      <button disabled={state.busy} onClick={() => { void controller.authAction('remote-clear-grant') }}>{t('remote.clearGrant')}</button>
    </div>
    {login !== undefined && <div role="status"><p>{login.userCode}</p><a href={login.verificationUri} target="_blank" rel="noreferrer">{t('remote.verify')}</a><button onClick={() => { void controller.cancelLogin(login.attemptId).finally(() => setLogin(undefined)) }}>{t('branch.cancel')}</button></div>}
    {state.repository === undefined ? <p>{t('details.noWorkspace')}</p> : <>
      <label>{t('remote.repository')} <select aria-label={t('remote.repository')} disabled={state.busy} value={state.target === undefined ? '' : `${state.target.owner}/${state.target.repo}`} onChange={event => { const selected = state.remotes.find(remote => `${remote.identity.owner}/${remote.identity.repo}` === event.target.value); if (selected !== undefined) void controller.load(kind, selected.identity, listState) }}>
        {state.remotes.map(remote => <option key={remote.name} value={`${remote.identity.owner}/${remote.identity.repo}`}>{remote.name} · {remote.identity.owner}/{remote.identity.repo}</option>)}
      </select></label>
      <div><button disabled={state.busy} onClick={() => { setKind('pulls'); void controller.load('pulls') }}>{t('remote.pulls')}</button><button disabled={state.busy} onClick={() => { setKind('issues'); void controller.load('issues') }}>{t('remote.issues')}</button><button disabled={state.busy} onClick={() => { if (detail === undefined) void controller.load(kind, undefined, listState); else void controller.open(detail.number, kind) }}>{t('details.refresh')}</button></div>
      {state.remotes.length === 0 && <p>{t('remote.noRemote')}</p>}
      {state.truncated && <p role="status">{t('remote.truncated')}</p>}
      <label>{t('remote.state')} <select aria-label={t('remote.state')} disabled={state.busy} value={listState} onChange={event => { const next = event.target.value as 'open' | 'closed' | 'all'; setListState(next); void controller.load(kind, undefined, next) }}>{(['open', 'closed', 'all'] as const).map(value => <option key={value} value={value}>{t(value === 'open' ? 'remote.stateOpen' : value === 'closed' ? 'remote.stateClosed' : 'remote.stateAll')}</option>)}</select></label>
      <ul>{state.items.map(item => <li key={item.number}><button disabled={state.busy} onClick={() => { void controller.open(item.number, kind) }}>#{item.number} {item.title} · {item.state}</button></li>)}</ul>
      {kind === 'pulls' && <button disabled={!writable} onClick={() => setCreate(!create)}>{t('remote.createPr')}</button>}
      {create && <form onSubmit={event => { event.preventDefault(); if (state.target !== undefined) write('remote-create-pr', { title, body, head: { ...state.target, owner: headOwner || state.target.owner, repo: headRepo || state.target.repo }, headRef, baseRef, draft: false }) }}>
        <p>{t('remote.pushedOnly')}</p>
        <label>{t('remote.prTitle')}<input required value={title} onChange={event => setTitle(event.target.value)} /></label>
        <label>{t('remote.headOwner')}<input value={headOwner} onChange={event => setHeadOwner(event.target.value)} /></label>
        <label>{t('remote.headRepo')}<input value={headRepo} onChange={event => setHeadRepo(event.target.value)} /></label>
        <label>{t('remote.headRef')}<input required value={headRef} onChange={event => setHeadRef(event.target.value)} /></label>
        <label>{t('remote.baseRef')}<input required value={baseRef} onChange={event => setBaseRef(event.target.value)} /></label>
        <button disabled={!writable}>{t('remote.createPr')}</button>
      </form>}
      {detail !== undefined && <section>
        <h4>#{detail.number} {detail.title}</h4>{detail.url !== undefined && <a href={detail.url} target="_blank" rel="noreferrer">{t('remote.openBrowser')}</a>}
        <p style={{ whiteSpace: 'pre-wrap' }}>{detail.body}</p>
        {state.comments.map(comment => <article key={comment.id}><strong>{comment.author?.login}</strong><p style={{ whiteSpace: 'pre-wrap' }}>{comment.body}</p></article>)}
        {pr === undefined ? <button disabled={!writable} onClick={() => write('remote-issue-branch')}>{t('remote.issueBranch')}</button> : <>
          <p>{pr.head.repository?.owner}:{pr.head.ref} → {pr.base.repository?.owner}:{pr.base.ref} · {pr.head.sha.slice(0, 12)}</p>
          <label>{t('remote.checkoutName')}<input value={checkoutName} onChange={event => setCheckoutName(event.target.value)} /></label>
          <button disabled={!writable} onClick={() => write('remote-checkout-pr', checkoutName.trim() === '' ? {} : { branch: checkoutName.trim() })}>{t('remote.checkout')}</button>
          <button disabled={!writable || state.facts?.actions.canClose === false || pr.state !== 'open'} onClick={() => setConfirm('remote-close-pr')}>{t('remote.close')}</button>
          <button disabled={!writable || state.facts?.actions.canMerge === false || pr.state !== 'open'} onClick={() => setConfirm('remote-merge-pr')}>{t('remote.merge')}</button>
          {confirm !== undefined && <div role="alertdialog" aria-label={t('remote.confirm')}><p>{t('remote.confirm')} · #{pr.number} · {pr.head.sha.slice(0, 12)} · {state.facts?.viewer?.login}</p><button disabled={!writable} onClick={() => write(confirm)}>{t('remote.confirm')}</button><button onClick={() => setConfirm(undefined)}>{t('branch.cancel')}</button></div>}
          {state.comparison?.files.items.map(file => {
            const diff = remoteDiff(file, state.comparison!.baseSha, state.comparison!.headSha)
            return <details key={file.path}><summary>{file.path} +{file.additions} −{file.deletions}</summary>{!diff.safe && <p>{t('remote.unsafeInline')}</p>}
              <pre style={{ overflow: 'auto' }}>{diff.lines.map((line, i) => <div key={i}>{line.anchor === undefined ? <span>{line.text}</span> : <button type="button" aria-pressed={anchor?.path === file.path && anchor.line === line.anchor.line && anchor.side === line.anchor.side} onClick={event => { if (event.shiftKey && anchor !== undefined && validRange(anchor, line.anchor!)) { setStartAnchor(anchor); setAnchor(line.anchor) } else { setAnchor(line.anchor); setStartAnchor(undefined) } }}>{line.oldLine ?? ' '} {line.newLine ?? ' '} {line.text}</button>}</div>)}</pre>
            </details>
          })}
          {state.inline.map(comment => <article key={comment.id}><strong>{comment.author?.login} · {comment.path}:{comment.line ?? '—'} {comment.outdated ? t('remote.outdated') : ''}</strong>{comment.replyTo !== undefined && <span> ↳ {comment.replyTo}</span>}<p>{comment.body}</p></article>)}
        </>}
      </section>}
      {(pr !== undefined || create) && <label>{t('remote.body')}<textarea value={body} onChange={event => setBody(event.target.value)} /></label>}
      {pr !== undefined && <div>
        <button disabled={!writable || body.trim() === '' || state.facts?.actions.canComment === false} onClick={() => write('remote-comment', { body })}>{t('remote.comment')}</button>
        <button disabled={!writable || body.trim() === '' || anchor === undefined || anchor.commitSha !== pr.head.sha || state.comparison?.files.truncated} onClick={() => write('remote-inline-comment', { body, expectedHeadSha: anchor?.commitSha, path: anchor?.path, line: anchor?.line, side: anchor?.side, ...(startAnchor === undefined ? {} : { startLine: startAnchor.line, startSide: startAnchor.side }) })}>{t('remote.inlineComment')}</button>
        {(['APPROVE', 'COMMENT', 'REQUEST_CHANGES'] as const).map(event => <button key={event} disabled={!writable || state.facts?.actions.canReview === false || event === 'COMMENT' && body.trim() === ''} onClick={() => write('remote-review', { body, event })}>{t(event === 'APPROVE' ? 'remote.approve' : event === 'COMMENT' ? 'remote.reviewComment' : 'remote.requestChanges')}</button>)}
      </div>}
    </>}
    {state.busy && <p role="status">{t('details.loading')}</p>}
    {state.error !== undefined && <p className={css.error} role="alert">{state.error}</p>}
    {state.checkout !== undefined && <p role="status">{t(state.checkout.error === undefined ? 'remote.checkoutDone' : 'remote.checkoutPartial')} · {state.checkout.branch} · {state.checkout.head ?? ''}<br />{state.checkout.privateRefWritten ? t('remote.privateRefPrepared') : ''} {state.checkout.trackingRefPrepared ? t('remote.trackingPrepared') : ''} {state.checkout.fetchMappingAdded ? t('remote.mappingPrepared') : ''} {state.checkout.upstreamNotConfigured ? t('remote.upstreamPending') : ''}</p>}
    {state.unknown && <p role="alert">{t('remote.unknown')}</p>}
  </div></div>
}


export function GitRemoteTitle({ t, remoteFeature }: PropsLocale<'git'> & { remoteFeature: GitRemoteFeature }): ReactNode {
  const notices = useSyncExternalStore(remoteFeature.subscribe, remoteFeature.getNotices)
  return <span>{t('remote.title')}{notices.length === 0 ? '' : ` (${notices.length})`}</span>
}
