import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitLocaleKey } from '../locales.ts'
import css from '../GitRemoteSurface.module.css'

const REVIEW_EVENTS = ['APPROVE', 'COMMENT', 'REQUEST_CHANGES'] as const
export type RemoteReviewEvent = typeof REVIEW_EVENTS[number]

function reviewKey(event: RemoteReviewEvent): GitLocaleKey {
  if (event === 'APPROVE') return 'remote.approve'
  if (event === 'COMMENT') return 'remote.reviewComment'
  return 'remote.requestChanges'
}

/** Comment body plus the comment / inline-comment / review write actions. */
export function RemoteComposer({ writable, canComment, canReview, body, inlineEnabled, onBody, onComment, onInlineComment, onReview, t }: {
  readonly writable: boolean
  readonly canComment: boolean | 'unknown' | undefined
  readonly canReview: boolean | 'unknown' | undefined
  readonly body: string
  readonly inlineEnabled: boolean
  readonly onBody: (value: string) => void
  readonly onComment: () => void
  readonly onInlineComment: () => void
  readonly onReview: (event: RemoteReviewEvent) => void
  readonly t: (key: GitLocaleKey) => string
}): ReactNode {
  return (
    <div className={css.composer}>
      <label className={css.field}>
        <span>{t('remote.body')}</span>
        <textarea
          value={body}
          aria-label={t('remote.body')}
          onChange={event => { onBody(event.target.value) }}
        />
      </label>
      <div className={css.composerActions}>
        <Button
          variant="primary"
          size="sm"
          disabled={!writable || body.trim() === '' || canComment === false}
          onClick={onComment}
        >
          {t('remote.comment')}
        </Button>
        <Button variant="outline" size="sm" disabled={!inlineEnabled} onClick={onInlineComment}>
          {t('remote.inlineComment')}
        </Button>
        {REVIEW_EVENTS.map(event => (
          <Button
            key={event}
            variant="outline"
            size="sm"
            disabled={!writable || canReview === false || (event === 'COMMENT' && body.trim() === '')}
            onClick={() => { onReview(event) }}
          >
            {t(reviewKey(event))}
          </Button>
        ))}
      </div>
    </div>
  )
}
