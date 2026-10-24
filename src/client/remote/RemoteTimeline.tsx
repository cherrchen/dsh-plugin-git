/** Chronological PR/issue activity: comments, commits, reviews and inline threads on one gutter line. */
import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { Tag, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels, TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconRightUpOutline16 } from '../../compat/dsh-icons.tsx'
import type { RemoteComment, RemoteCommit, RemoteReview, RemoteReviewState } from '../../remote/provider.ts'
import type { GitLocaleKey } from '../locales.ts'
import { remoteTimeline, type RemoteThread, type RemoteTimelineEntry } from './timeline.ts'
import { RemoteMarkdown } from './RemoteMarkdown.tsx'
import { RemoteAvatar } from './RemoteAvatar.tsx'
import css from '../GitRemoteSurface.module.css'

function reviewStateKey(state: RemoteReviewState): GitLocaleKey {
  if (state === 'approved') return 'remote.reviewApproved'
  if (state === 'changes-requested') return 'remote.reviewChanges'
  if (state === 'dismissed') return 'remote.reviewDismissed'
  if (state === 'pending') return 'remote.reviewPending'
  return 'remote.reviewCommented'
}
function reviewStateTone(state: RemoteReviewState): TagTone {
  if (state === 'approved') return 'success'
  if (state === 'changes-requested') return 'warning'
  if (state === 'commented') return 'info'
  return 'quiet'
}
function reviewMarkerTone(state: RemoteReviewState): string {
  if (state === 'approved') return 'var(--dsw-alias-state-success-primary)'
  if (state === 'changes-requested') return 'var(--dsw-alias-state-warning-primary, var(--dsw-alias-state-error-primary))'
  return 'var(--dsw-alias-label-tertiary)'
}
function ExternalLink({ url, label }: { readonly url: string; readonly label: string }): ReactNode {
  return (
    <Tooltip label={label} side="top" delayMs={200}>
      <a className={css.iconLink} href={url} target="_blank" rel="noreferrer" aria-label={label}>
        <IconRightUpOutline16 size={14} />
      </a>
    </Tooltip>
  )
}
function When({ at }: { readonly at: string | undefined }): ReactNode {
  if (at === undefined) return null
  return <time className={css.tlMeta} dateTime={at} title={at}>{at.slice(0, 10)}</time>
}
function Card({ head, children }: { readonly head: ReactNode; readonly children?: ReactNode }): ReactNode {
  return (
    <article className={css.tlCard}>
      <header className={css.tlCardHead}>{head}</header>
      {children !== undefined && <div className={css.tlCardBody}>{children}</div>}
    </article>
  )
}
function CommentBody({ comment, labels, detailsLabel }: {
  readonly comment: RemoteComment
  readonly labels: MarkdownLabels
  readonly detailsLabel: string
}): ReactNode {
  return <RemoteMarkdown text={comment.body} labels={labels} detailsLabel={detailsLabel} />
}
function ThreadCard({ thread, labels, detailsLabel, t }: {
  readonly thread: RemoteThread
  readonly labels: MarkdownLabels
  readonly detailsLabel: string
  readonly t: (key: GitLocaleKey) => string
}): ReactNode {
  const { root } = thread
  return (
    <article className={css.tlCard}>
      <header className={css.tlCardHead}>
        <code className={css.commentRef}>{root.path ?? ''}:{root.line ?? '—'}</code>
        {root.outdated && <Tag tone="quiet">{t('remote.outdated')}</Tag>}
        {root.url !== undefined && <ExternalLink url={root.url} label={t('remote.openBrowser')} />}
      </header>
      {[root, ...thread.replies].map((comment, index) => (
        <div key={comment.id} className={index === 0 ? css.tlReply : `${css.tlReply} ${css.tlReplyNext}`}>
          <div className={css.tlReplyHead}>
            <strong>{comment.author?.login}</strong>
            <When at={comment.createdAt} />
          </div>
          <CommentBody comment={comment} labels={labels} detailsLabel={detailsLabel} />
        </div>
      ))}
    </article>
  )
}
function Entry({ entry, labels, detailsLabel, t }: {
  readonly entry: RemoteTimelineEntry
  readonly labels: MarkdownLabels
  readonly detailsLabel: string
  readonly t: (key: GitLocaleKey) => string
}): ReactNode {
  if (entry.kind === 'commit') {
    const { commit } = entry
    return (
      <div className={css.tlItem}>
        <span className={css.tlDot} aria-hidden="true" />
        <div className={css.commitRow}>
          <code className={css.commitSha}>{commit.sha.slice(0, 7)}</code>
          <span className={css.commitSubject}>{commit.subject}</span>
          <span className={css.commentRef}>
            {commit.author?.login ?? ''}<When at={entry.at} />
          </span>
          {commit.url !== undefined && <ExternalLink url={commit.url} label={t('remote.openBrowser')} />}
        </div>
      </div>
    )
  }
  if (entry.kind === 'comment') {
    const { comment } = entry
    return (
      <div className={css.tlItem}>
        <span className={css.tlAvatar}><RemoteAvatar login={comment.author?.login} url={comment.author?.avatarUrl} size={20} /></span>
        <Card head={<>
          <strong>{comment.author?.login}</strong>
          <span className={css.tlMeta}>{t('remote.commented')}</span>
          <When at={entry.at} />
          {comment.url !== undefined && <ExternalLink url={comment.url} label={t('remote.openBrowser')} />}
        </>}>
          <CommentBody comment={comment} labels={labels} detailsLabel={detailsLabel} />
        </Card>
      </div>
    )
  }
  if (entry.kind === 'review') {
    const { review, threads } = entry
    return (
      <div className={css.tlItem}>
        <span className={css.tlDot} style={{ borderColor: reviewMarkerTone(review.state) }} aria-hidden="true" />
        <div className={css.tlReviewHead}>
          <strong>{review.author?.login}</strong>
          <Tag tone={reviewStateTone(review.state)}>{t(reviewStateKey(review.state))}</Tag>
          <When at={entry.at} />
          {review.url !== undefined && <ExternalLink url={review.url} label={t('remote.openBrowser')} />}
        </div>
        {review.body !== '' && (
          <article className={css.tlCard}>
            <div className={css.tlCardBody}>
              <RemoteMarkdown text={review.body} labels={labels} detailsLabel={detailsLabel} />
            </div>
          </article>
        )}
        {threads.map(thread => (
          <ThreadCard key={thread.root.id} thread={thread} labels={labels} detailsLabel={detailsLabel} t={t} />
        ))}
      </div>
    )
  }
  const { thread } = entry
  return (
    <div className={css.tlItem}>
      <span className={css.tlDot} aria-hidden="true" />
      <ThreadCard thread={thread} labels={labels} detailsLabel={detailsLabel} t={t} />
    </div>
  )
}

export function RemoteTimeline({ comments, inline, commits, reviews, labels, t }: {
  readonly comments: readonly RemoteComment[]
  readonly inline: readonly RemoteComment[]
  readonly commits: readonly RemoteCommit[]
  readonly reviews: readonly RemoteReview[]
  readonly labels: MarkdownLabels
  readonly t: (key: GitLocaleKey) => string
}): ReactNode {
  const entries = useMemo(() => remoteTimeline({ comments, inline, commits, reviews }), [comments, inline, commits, reviews])
  const detailsLabel = t('remote.details')
  return (
    <section className={css.timeline} aria-label={t('remote.timeline')}>
      {entries.map(entry => (
        <Entry key={entry.key} entry={entry} labels={labels} detailsLabel={detailsLabel} t={t} />
      ))}
    </section>
  )
}
