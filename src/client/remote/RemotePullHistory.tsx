/** Pull-request history sections: the commit list and reviews with their inline comments nested. */
import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { MarkdownText, Tag, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels, TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconRightUpOutline16 } from '../../compat/dsh-icons.tsx'
import type { RemoteComment, RemoteCommit, RemoteReview, RemoteReviewState } from '../../remote/provider.ts'
import type { GitLocaleKey } from '../locales.ts'
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
function ExternalLink({ url, label }: { readonly url: string; readonly label: string }): ReactNode {
  return (
    <Tooltip label={label} side="top" delayMs={200}>
      <a className={css.iconLink} href={url} target="_blank" rel="noreferrer" aria-label={label}>
        <IconRightUpOutline16 size={14} />
      </a>
    </Tooltip>
  )
}
/** One review comment rendered without its diff: author plus the path:line reference. */
function InlineCommentCard({ comment, labels, t }: {
  readonly comment: RemoteComment
  readonly labels: MarkdownLabels
  readonly t: (key: GitLocaleKey) => string
}): ReactNode {
  return (
    <article className={css.commentCard}>
      <strong className={css.commentAuthor}>
        {comment.author?.login}
        <span className={css.commentRef}> · {comment.path ?? ''}:{comment.line ?? '—'}</span>
        {comment.outdated && <span className={css.commentRef}> · {t('remote.outdated')}</span>}
      </strong>
      <MarkdownText text={comment.body} labels={labels} variant="compact" />
    </article>
  )
}
/** Commits and reviews of the open pull request; inline comments nest under their review. */
export function RemotePullHistory({ commits, reviews, inline, labels, t }: {
  readonly commits: readonly RemoteCommit[]
  readonly reviews: readonly RemoteReview[]
  readonly inline: readonly RemoteComment[]
  readonly labels: MarkdownLabels
  readonly t: (key: GitLocaleKey) => string
}): ReactNode {
  const { byReview, orphans } = useMemo(() => {
    const byReview = new Map<string, RemoteComment[]>()
    const orphans: RemoteComment[] = []
    const known = new Set(reviews.map(review => review.id))
    for (const comment of inline) {
      if (comment.reviewId !== undefined && known.has(comment.reviewId)) {
        const group = byReview.get(comment.reviewId) ?? []
        group.push(comment)
        byReview.set(comment.reviewId, group)
      } else {
        orphans.push(comment)
      }
    }
    return { byReview, orphans }
  }, [reviews, inline])
  return (
    <>
      {commits.length > 0 && (
        <section className={css.section} aria-label={t('remote.commits')}>
          <h3 className={css.sectionHead}>
            <span className={css.sectionTitle}>
              {t('remote.commits')}
              <span className={css.sectionCount}>{commits.length}</span>
            </span>
          </h3>
          {commits.map(entry => (
            <div key={entry.sha} className={css.commitRow}>
              <code className={css.commitSha}>{entry.sha.slice(0, 7)}</code>
              <span className={css.commitSubject}>{entry.subject}</span>
              <span className={css.commentRef}>
                {entry.author?.login ?? ''}{entry.date === undefined ? '' : ` · ${entry.date.slice(0, 10)}`}
              </span>
              {entry.url !== undefined && <ExternalLink url={entry.url} label={t('remote.openBrowser')} />}
            </div>
          ))}
        </section>
      )}
      {(reviews.length > 0 || orphans.length > 0) && (
        <section className={css.section} aria-label={t('remote.reviews')}>
          <h3 className={css.sectionHead}>
            <span className={css.sectionTitle}>
              {t('remote.reviews')}
              <span className={css.sectionCount}>{reviews.length}</span>
            </span>
          </h3>
          {reviews.map(review => (
            <article key={review.id} className={css.commentCard}>
              <strong className={css.commentAuthor}>
                {review.author?.login}
                <Tag tone={reviewStateTone(review.state)}>{t(reviewStateKey(review.state))}</Tag>
                {review.submittedAt !== undefined && <span className={css.commentRef}> · {review.submittedAt.slice(0, 10)}</span>}
                {review.url !== undefined && <ExternalLink url={review.url} label={t('remote.openBrowser')} />}
              </strong>
              {review.body !== '' && <MarkdownText text={review.body} labels={labels} variant="compact" />}
              {byReview.get(review.id)?.map(comment => (
                <InlineCommentCard key={comment.id} comment={comment} labels={labels} t={t} />
              ))}
            </article>
          ))}
          {orphans.length > 0 && (
            <>
              <h3 className={css.sectionHead}>
                <span className={css.sectionTitle}>
                  {t('remote.inlineComments')}
                  <span className={css.sectionCount}>{orphans.length}</span>
                </span>
              </h3>
              {orphans.map(comment => (
                <InlineCommentCard key={comment.id} comment={comment} labels={labels} t={t} />
              ))}
            </>
          )}
        </section>
      )}
    </>
  )
}
