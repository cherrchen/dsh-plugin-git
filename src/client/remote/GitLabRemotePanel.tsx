/** Portable GitLab view. All requests go through the negotiated scoped controller. */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Button, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitLocaleKey } from '../locales.ts'
import type { GitLabRemoteController } from '../gitlab-remote.ts'
import type { ScopedRemoteNote } from '../../remote/provider.ts'
import { gitLabWebUrl } from '../../remote/gitlab-model.ts'
import { GitLabMarkdown } from './GitLabMarkdown.tsx'
import css from '../GitRemoteSurface.module.css'

type T = (key: GitLocaleKey) => string
const allowed = (value: unknown) => value === true || value === 'unknown'
const stepKeys: Readonly<Record<string, GitLocaleKey>> = {
  comment: 'gitlab.stepComment', approve: 'gitlab.stepApprove', 'close-pr': 'gitlab.stepClose', 'merge-pr': 'gitlab.stepMerge', 'merge-verification': 'gitlab.stepMergeVerification', 'create-pr': 'gitlab.stepCreate',
  'private-ref': 'gitlab.stepPrivateRef', 'tracking-ref': 'gitlab.stepTracking', 'fetch-mapping': 'gitlab.stepMapping', switch: 'gitlab.stepSwitch', upstream: 'gitlab.stepUpstream', 'create-branch': 'gitlab.stepBranch', 'switch-branch': 'gitlab.stepSwitch',
}
const statusKeys: Readonly<Record<string, GitLocaleKey>> = { succeeded: 'gitlab.succeeded', failed: 'gitlab.failed', 'not-sent': 'gitlab.notSent', partial: 'gitlab.partial', unknown: 'gitlab.stepUnknown' }
const resultErrorKeys: Readonly<Record<string, GitLocaleKey>> = { 'merge-method-unverified': 'gitlab.mergeMethodUnverified', 'merge-method-mismatch': 'gitlab.mergeMethodMismatch', 'source-removal-reported': 'gitlab.sourceRemovalReported' }
function Result({ value, t }: { readonly value: unknown; readonly t: T }): ReactNode {
  if (typeof value !== 'object' || value === null) return null
  const result = value as { outcome?: unknown; steps?: unknown; receipt?: unknown }
  const status = typeof result.outcome === 'string' ? statusKeys[result.outcome] : undefined
  const steps = Array.isArray(result.steps) ? result.steps.slice(0, 12) : []
  const receipt = typeof result.receipt === 'object' && result.receipt !== null ? result.receipt as Record<string, unknown> : {}
  const receiptError = typeof receipt['error'] === 'string' ? receipt['error'] : undefined
  const receiptErrorKey = receiptError === undefined ? undefined : resultErrorKeys[receiptError]
  return <section className={css.section} aria-label={t('gitlab.result')}>
    <strong>{t('gitlab.result')}: {t(status ?? 'gitlab.stepUnknown')}</strong>
    {steps.length > 0 && <ul>{steps.map((raw: unknown, index: number) => {
      if (typeof raw !== 'object' || raw === null) return null
      const step = raw as { kind?: unknown; state?: unknown }, kind = typeof step.kind === 'string' ? stepKeys[step.kind] : undefined, state = typeof step.state === 'string' ? statusKeys[step.state] : undefined
      return <li key={index}>{t(kind ?? 'gitlab.result')}: {t(state ?? 'gitlab.stepUnknown')}</li>
    })}</ul>}
    {typeof receipt['branch'] === 'string' && <p className={css.detailMeta}>{receipt['branch']}</p>}
    {typeof receipt['head'] === 'string' && <p className={css.detailMeta}>{receipt['head']}</p>}
    {receiptError !== undefined && <p className={css.note}>{receiptErrorKey === undefined ? receiptError : t(receiptErrorKey)}</p>}
  </section>
}
function Note({ note, instance, t }: { readonly note: ScopedRemoteNote; readonly instance: string; readonly t: T }): ReactNode {
  const link = gitLabWebUrl(instance, note.url)
  return <article className={css.gitlabNote}>
    <p className={css.itemMeta}>{note.author?.login ?? '—'} {note.createdAt ?? ''} {note.resolvable === true ? t(note.resolved === true ? 'gitlab.resolved' : 'gitlab.unresolved') : ''}</p>
    {note.position !== undefined && <p className={css.detailMeta}>{note.position.oldPath ?? ''}:{note.position.oldLine ?? '—'} → {note.position.newPath ?? ''}:{note.position.newLine ?? '—'}</p>}
    <GitLabMarkdown text={note.body} instance={instance} detailsLabel={t('remote.details')} />
    {link !== undefined && <a href={link} target="_blank" rel="noopener noreferrer">{t('remote.openBrowser')}</a>}
  </article>
}
export function GitLabRemotePanel({ controller, repository, t }: { readonly controller: GitLabRemoteController; readonly repository: string | undefined; readonly t: T }): ReactNode {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const [body, setBody] = useState(''), [branch, setBranch] = useState('')
  const [creating, setCreating] = useState(false), [title, setTitle] = useState(''), [description, setDescription] = useState(''), [headRef, setHeadRef] = useState(''), [baseRef, setBaseRef] = useState(''), [sourceIndex, setSourceIndex] = useState(0), [draft, setDraft] = useState(false)
  useEffect(() => { controller.setRepository(repository) }, [controller, repository])
  useEffect(() => { setBody(''); setBranch(''); setCreating(false) }, [state.target?.scope.instance, state.target?.path, state.detail?.number, state.kind])
  if (!state.hostSupported) return <p className={css.empty}>{t('gitlab.oldHost')}</p>
  if (repository === undefined) return <p className={css.empty}>{t('details.noWorkspace')}</p>
  const target = state.target, detail = state.detail, facts = state.facts, pull = detail !== undefined && 'head' in detail ? detail : undefined
  const writable = facts?.viewer !== undefined && !state.busy && !state.blocked
  const locked = detail?.rawState === 'locked' || detail?.state === 'unknown'
  const canComment = writable && !locked && pull !== undefined && facts.operationSupport.comment.supported && allowed(facts.actions.canComment)
  const canReview = writable && !locked && pull !== undefined && facts.operationSupport.review.supported && allowed(facts.actions.canReview)
  const canCreate = writable && facts.actionScope.object === undefined && facts.operationSupport['create-pr'].supported && allowed(facts.actions.canCreatePr)
  const link = target === undefined ? undefined : gitLabWebUrl(target.scope.instance, detail?.url)
  const selected = state.targets.findIndex(item => item.identity.scope.instance === target?.scope.instance && item.identity.path === target?.path)
  const sources = state.targets.filter(item => item.identity.scope.instance === target?.scope.instance)
  const authState = state.capability?.auth.state
  const authLabel: GitLocaleKey = authState === 'authenticated' ? 'gitlab.authConnected' : authState === 'anonymous' ? 'gitlab.authAnonymous' : authState === 'invalid' ? 'gitlab.authInvalid' : 'gitlab.authDisconnected'
  const canClose = writable && !locked && pull !== undefined && facts.operationSupport['close-pr'].supported && allowed(facts.actions.canClose)
  const canMerge = writable && !locked && pull !== undefined && facts.operationSupport['merge-pr'].supported && allowed(facts.actions.canMerge)
  return <div className={css.body} data-gitlab-remote-panel=""><div className={css.pad}>
    <div className={css.gitlabControls}>
      <label>{t('gitlab.repository')}<select aria-label={t('gitlab.repository')} value={selected < 0 ? '' : String(selected)} disabled={state.busy || state.blocked || state.targets.length === 0} onChange={event => { const item = state.targets[Number(event.target.value)]; if (item !== undefined) void controller.select(item.identity) }}>
        {state.targets.length === 0 && <option value="">—</option>}
        {state.targets.map((item, index) => <option value={index} key={`${item.name}:${item.identity.scope.instance}:${item.identity.path}`}>{item.name} · {item.identity.scope.instance} / {item.identity.path}</option>)}
      </select></label>
      <Button variant="ghost" size="sm" disabled={state.busy || target === undefined && !state.unresolved} onClick={() => { if (target === undefined) void controller.discover(); else void controller.refresh() }}>{t('gitlab.refresh')}</Button>
    </div>
    {state.unresolved && <p className={css.note}>{t('gitlab.unregistered')}</p>}
    {target !== undefined && <p className={css.note}>{t('gitlab.noticeLimit')}</p>}
    {state.notices.map(notice => <p className={css.notice} role="status" key={`${notice.kind}:${notice.id}:${notice.state}:${notice.updatedAt ?? ''}`}>{t(notice.kind === 'review-requested' ? 'gitlab.noticeReview' : notice.kind === 'merged' ? 'gitlab.noticeMerged' : notice.kind === 'closed' ? 'gitlab.noticeClosed' : 'gitlab.noticeCreate')} · {notice.title}</p>)}
    {state.busy && <p role="status" className={css.note}>{t('gitlab.loading')}</p>}
    {state.error !== undefined && <p className={css.error} role="alert">{state.error}{state.errorDetails?.['reason'] === undefined ? '' : ` · ${state.errorDetails['reason']}`}</p>}
    {target !== undefined && <section className={css.authSection} aria-label={t('remote.auth')}>
      <strong>{t('remote.auth')} · {target.scope.instance}</strong>
      <span>{t(authLabel)} · {state.facts?.viewer?.login ?? state.capability?.viewer?.login ?? '—'}</span>
      <p className={css.note}>{t('gitlab.authHint')}</p>
      <div className={css.gitlabActions}>
        <Button variant="ghost" size="sm" disabled={state.busy || state.blocked || state.capability?.loginAvailable !== true || state.login !== undefined} onClick={() => { void controller.login() }}>{t('gitlab.connect')}</Button>
        <Button variant="ghost" size="sm" disabled={state.busy || state.blocked} onClick={() => { void controller.authAction('remote-retry-auth') }}>{t('gitlab.retry')}</Button>
        <Button variant="ghost" size="sm" disabled={state.busy || state.blocked} onClick={() => { void controller.authAction('remote-sign-out') }}>{t('gitlab.signOut')}</Button>
        <Button variant="ghost" size="sm" disabled={state.busy || state.blocked} onClick={() => { void controller.authAction('remote-clear-grant') }}>{t('gitlab.clearGrant')}</Button>
      </div>
      {state.login !== undefined && <div className={css.loginCard}><span className={css.loginCode}>{state.login.userCode}</span><a className={css.loginLink} href={state.login.verificationUri} target="_blank" rel="noopener noreferrer">{t('gitlab.verify')}</a><Button variant="ghost" size="sm" onClick={() => { void controller.cancelLogin() }}>{t('branch.cancel')}</Button></div>}
    </section>}
    {state.outcome !== undefined && <Result value={state.outcome} t={t} />}
    {state.blocked && <section className={css.confirmCard} role="alert">
      <p>{t('gitlab.partial')}</p>
      {(state.blockedAction === 'remote-checkout-pr' || state.blockedAction === 'remote-issue-branch') && <p>{t('gitlab.localInspect')}</p>}
      {state.errorDetails?.['commentSucceeded'] === true && <p>{t('gitlab.commentSucceeded')}</p>}
      <p>{t('gitlab.reconcileHint')}</p>
      <Button variant="ghost" size="sm" disabled={state.busy || !state.reconciled} onClick={() => { controller.acknowledgeReconciliation(); setBody('') }}>{t('gitlab.reconcile')}</Button>
    </section>}
    {target !== undefined && detail === undefined && <>
      <div className={css.gitlabActions}>
        <Pill active={state.kind === 'pulls'} disabled={state.busy || state.blocked} onClick={() => { void controller.list('pulls', state.filter) }}>{t('gitlab.mergeRequests')}</Pill>
        <Pill active={state.kind === 'issues'} disabled={state.busy || state.blocked} onClick={() => { void controller.list('issues', state.filter) }}>{t('remote.issues')}</Pill>
      </div>
      <div className={css.gitlabActions}>{(['open', 'closed', 'all'] as const).map(filter => <Pill key={filter} active={state.filter === filter} disabled={state.busy || state.blocked} onClick={() => { void controller.list(state.kind, filter) }}>{t(filter === 'open' ? 'remote.stateOpen' : filter === 'closed' ? 'remote.stateClosed' : 'remote.stateAll')}</Pill>)}</div>
      <ul className={css.itemList}>{state.items.map(item => <li key={`${item.id}:${item.number}`}><button className={css.itemRow} type="button" disabled={state.busy || state.blocked} onClick={() => { void controller.open(item.number) }}><span className={css.itemMain}><span className={css.itemTitle}>{item.title}</span><span className={css.itemMeta}>#{item.number} · {item.rawState} · {item.author?.login ?? '—'}</span></span></button></li>)}</ul>
      {state.itemsNext !== undefined && <Button variant="ghost" size="sm" disabled={state.busy} onClick={() => { void controller.more('items') }}>{t('gitlab.more')}</Button>}
      {!state.busy && state.items.length === 0 && state.error === undefined && <p className={css.empty}>{t('remote.noItems')}</p>}
      {canCreate && !creating && <Button variant="ghost" size="sm" onClick={() => { setCreating(true); setSourceIndex(0) }}>{t('gitlab.create')}</Button>}
      {creating && <form className={css.gitlabForm} onSubmit={event => { event.preventDefault(); const source = sources[sourceIndex]?.identity; if (source !== undefined) void controller.create({ source, title, body: description, headRef, baseRef, draft }).then(() => { if (controller.getSnapshot().error === undefined && !controller.getSnapshot().blocked) { setCreating(false); void controller.refresh() } }) }}>
        <strong>{t('gitlab.create')}</strong><p className={css.note}>{t('remote.pushedOnly')}</p>
        <label>{t('gitlab.target')}: {target.path}</label><label>{t('gitlab.source')}<select value={sourceIndex} onChange={event => { setSourceIndex(Number(event.target.value)) }}>{sources.map((item, index) => <option value={index} key={`${item.name}:${item.identity.path}`}>{item.name} · {item.identity.path}</option>)}</select></label>
        <label>{t('remote.prTitle')}<input required value={title} onChange={event => { setTitle(event.target.value) }} /></label>
        <label>{t('remote.headRef')}<input required value={headRef} onChange={event => { setHeadRef(event.target.value) }} /></label>
        <label>{t('remote.baseRef')}<input required value={baseRef} onChange={event => { setBaseRef(event.target.value) }} /></label>
        <label>{t('remote.body')}<textarea value={description} onChange={event => { setDescription(event.target.value) }} /></label>
        <label><input type="checkbox" checked={draft} onChange={event => { setDraft(event.target.checked) }} /> {t('remote.draft')}</label>
        <div className={css.gitlabActions}><Button variant="ghost" size="sm" type="submit" disabled={state.busy || !canCreate}>{t('gitlab.submit')}</Button><Button variant="ghost" size="sm" onClick={() => { setCreating(false) }}>{t('branch.cancel')}</Button></div>
      </form>}
    </>}
    {target !== undefined && detail !== undefined && <>
      <Button variant="ghost" size="sm" disabled={state.busy || state.blocked} onClick={() => { void controller.list(state.kind, state.filter) }}>{t('gitlab.back')}</Button>
      <h3 className={css.detailTitle}>#{detail.number} · {detail.title}</h3><p className={css.detailMeta}>{detail.rawState} · {detail.author?.login ?? '—'}</p>
      {link !== undefined && <a href={link} target="_blank" rel="noopener noreferrer">{t('remote.openBrowser')}</a>}
      {pull !== undefined && <p className={css.detailMeta}>{pull.head.projectId ?? '—'}:{pull.head.ref} ({pull.head.sha ?? '—'}) → {pull.base.projectId ?? '—'}:{pull.base.ref} ({pull.base.sha ?? '—'}) {pull.draft === true ? `· ${t('remote.draft')}` : ''}</p>}
      <GitLabMarkdown text={detail.body} instance={target.scope.instance} detailsLabel={t('remote.details')} />
      {state.unavailable.length > 0 && <p className={css.note}>{t('gitlab.readUnavailable')}</p>}
      {pull !== undefined && state.approvals !== undefined && <section className={css.section}><h4 className={css.sectionHead}>{t('gitlab.approvals')}</h4><p>{state.approvals.approved === undefined ? t('gitlab.stepUnknown') : state.approvals.approved ? t('remote.reviewApproved') : t('remote.reviewPending')} · {state.approvals.approvedBy.map(user => user.login).join(', ')} {state.approvals.approvalsLeft === undefined ? '' : `(${state.approvals.approvalsLeft})`}</p></section>}
      <section className={css.section}><h4 className={css.sectionHead}>{t('gitlab.notes')}</h4>{state.comments?.items.map(note => <Note key={note.id} note={note} instance={target.scope.instance} t={t} />)}{state.comments?.next !== undefined && <Button variant="ghost" size="sm" disabled={state.busy} onClick={() => { void controller.more('comments') }}>{t('gitlab.more')}</Button>}</section>
      <section className={css.section}><h4 className={css.sectionHead}>{t('gitlab.discussions')}</h4><p className={css.note}>{t('gitlab.inlineDisabled')}</p>{state.discussions?.items.map(discussion => <div key={discussion.id}>{discussion.notes.map(note => <Note key={`${discussion.id}:${note.id}`} note={note} instance={target.scope.instance} t={t} />)}</div>)}{state.discussions?.next !== undefined && <Button variant="ghost" size="sm" disabled={state.busy} onClick={() => { void controller.more('discussions') }}>{t('gitlab.more')}</Button>}</section>
      {pull !== undefined && <><section className={css.section}><h4 className={css.sectionHead}>{t('gitlab.commits')}</h4>{state.commits?.items.map(commit => <p className={css.detailMeta} key={commit.sha}>{commit.sha.slice(0, 12)} · {commit.subject}</p>)}{state.commits?.next !== undefined && <Button variant="ghost" size="sm" disabled={state.busy} onClick={() => { void controller.more('commits') }}>{t('gitlab.more')}</Button>}</section>
        <section className={css.section}><h4 className={css.sectionHead}>{t('remote.filesChanged')}</h4><p className={css.note}>{t('gitlab.diffLimit')}</p>{state.files?.files.items.map(file => <details key={`${file.oldPath}:${file.newPath}`}><summary>{file.newPath} · {file.status} · {file.content}</summary>{file.patch !== undefined && <pre className={css.gitlabPatch}>{file.patch}</pre>}</details>)}{state.files?.files.next !== undefined && <Button variant="ghost" size="sm" disabled={state.busy} onClick={() => { void controller.more('files') }}>{t('gitlab.more')}</Button>}</section></>}
      <section className={css.gitlabForm}>
        {pull !== undefined ? <><label>{t('remote.checkoutName')}<input value={branch} onChange={event => { setBranch(event.target.value) }} /></label><Button variant="ghost" size="sm" disabled={!writable || locked || pull.head.sha === null} onClick={() => { void controller.write('remote-checkout-pr', branch === '' ? {} : { branch }) }}>{t('remote.checkout')}</Button></> : <Button variant="ghost" size="sm" disabled={!writable || locked} onClick={() => { void controller.write('remote-issue-branch') }}>{t('remote.issueBranch')}</Button>}
        {pull !== undefined && <><label>{t('remote.body')}<textarea value={body} onChange={event => { setBody(event.target.value) }} /></label><div className={css.gitlabActions}>
          <Button variant="ghost" size="sm" disabled={!canComment || body.trim() === ''} onClick={() => { void controller.write('remote-comment', { body }).then(() => { if (controller.getSnapshot().error === undefined && !controller.getSnapshot().blocked) setBody('') }) }}>{t('remote.comment')}</Button>
          <Button variant="ghost" size="sm" disabled={!canReview || !facts.supportedReviewEvents.includes('COMMENT') || body.trim() === ''} onClick={() => { void controller.write('remote-review', { event: 'COMMENT', body }).then(() => { if (controller.getSnapshot().error === undefined && !controller.getSnapshot().blocked) setBody('') }) }}>{t('remote.reviewComment')}</Button>
          <Button variant="ghost" size="sm" disabled={!canReview || !facts.supportedReviewEvents.includes('APPROVE') || !allowed(facts.reviewPermissions?.APPROVE)} onClick={() => { void controller.write('remote-review', { event: 'APPROVE', body }) }}>{t('remote.approve')}</Button>
        </div><div className={css.gitlabActions}>
          <Button variant="ghost" size="sm" disabled={!canClose} onClick={() => { controller.prepare('close') }}>{t('remote.close')}</Button>
          <Button variant="ghost" size="sm" disabled={!canMerge || !facts.supportedMergeMethods.includes('merge')} onClick={() => { controller.prepare('merge', 'merge') }}>{t('gitlab.directMerge')}</Button>
          <Button variant="ghost" size="sm" disabled={!canMerge || !facts.supportedMergeMethods.includes('squash')} onClick={() => { controller.prepare('merge', 'squash') }}>{t('gitlab.squashMerge')}</Button>
        </div></>}
      </section>
      {state.confirmation !== undefined && <div className={css.confirmCard} role="alertdialog" aria-label={t('remote.confirm')}><p>{t('remote.confirm')} · {target.scope.instance} / {target.path} · #{state.confirmation.number} · {state.confirmation.sha} · {facts?.viewer?.login}</p><p>{state.confirmation.action === 'close' ? t('remote.close') : t(state.confirmation.method === 'squash' ? 'gitlab.squashMerge' : 'gitlab.directMerge')}</p><Button variant="ghost" size="sm" disabled={state.busy} onClick={() => { void controller.confirm() }}>{t('remote.confirm')}</Button><Button variant="ghost" size="sm" onClick={() => { controller.cancelConfirmation() }}>{t('branch.cancel')}</Button></div>}
    </>}
  </div></div>
}
