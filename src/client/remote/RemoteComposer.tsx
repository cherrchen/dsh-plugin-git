import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ScopedRemoteRepositoryFacts } from '../../remote/provider.ts'
import type { GitLocaleKey } from '../locales.ts'
import css from '../GitRemoteSurface.module.css'

const DEFAULT_EVENTS = ['APPROVE', 'COMMENT', 'REQUEST_CHANGES'] as const
export type RemoteReviewEvent = 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES'

function reviewKey(event: RemoteReviewEvent): GitLocaleKey {
  if (event === 'APPROVE') return 'remote.approve'
  if (event === 'COMMENT') return 'remote.reviewComment'
  return 'remote.requestChanges'
}

/** Comment body plus the comment / review write actions. */
export function RemoteComposer({ writable, canComment, canReview, reviewPermissions, events, body, onBody, onComment, onReview, t }: {
  readonly writable: boolean
  readonly canComment: boolean | 'unknown' | undefined
  readonly canReview: boolean | 'unknown' | undefined
  /** Per-event permission facts (GitLab approval rights); an explicit false hides that action. */
  readonly reviewPermissions?: ScopedRemoteRepositoryFacts['reviewPermissions']
  /** Review events the provider accepts; GitLab scopes exclude REQUEST_CHANGES when unsupported. */
  readonly events?: readonly RemoteReviewEvent[] | undefined
  readonly body: string
  readonly onBody: (value: string) => void
  readonly onComment: () => void
  readonly onReview: (event: RemoteReviewEvent) => void
  readonly t: (key: GitLocaleKey) => string
}): ReactNode {
  const list = events ?? DEFAULT_EVENTS
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
        {list.map(event => {
          const permission = reviewPermissions?.[event]
          if (permission === false) return null
          return (
            <Button
              key={event}
              variant="outline"
              size="sm"
              disabled={!writable || canReview === false || (event === 'COMMENT' && body.trim() === '')}
              onClick={() => { onReview(event) }}
            >
              {t(reviewKey(event))}
            </Button>
          )
        })}
      </div>
    </div>
  )
}
