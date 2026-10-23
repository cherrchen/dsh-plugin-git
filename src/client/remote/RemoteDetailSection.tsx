import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { Tag, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import { DshCompactMarkdownText } from '../../compat/dsh-markdown.tsx'
import { IconRightUpOutline16 } from '../../compat/dsh-icons.tsx'
import type { RemoteComment, RemoteIssue, RemotePull } from '../../remote/provider.ts'
import type { GitLocaleKey } from '../locales.ts'
import css from '../GitRemoteSurface.module.css'

/** Localized chrome for every MarkdownText on this page. */
export function remoteMarkdownLabels(t: (key: GitLocaleKey) => string): MarkdownLabels {
  return {
    code: { copyLabel: t('remote.copy'), copiedLabel: t('remote.copied') },
    footnotes: t('remote.footnotes'),
  }
}

function detailStateKey(state: RemoteIssue['state'] | RemotePull['state']): GitLocaleKey {
  if (state === 'closed') return 'remote.stateClosed'
  if (state === 'merged') return 'remote.stateMerged'
  return 'remote.stateOpen'
}

function detailStateTone(state: RemoteIssue['state'] | RemotePull['state']): 'success' | 'neutral' | 'info' {
  if (state === 'closed') return 'neutral'
  if (state === 'merged') return 'info'
  return 'success'
}

/** One comment card: author line plus the markdown body. */
export function RemoteCommentCard({ comment, labels }: {
  readonly comment: RemoteComment
  readonly labels: MarkdownLabels
}): ReactNode {
  return (
    <article className={css.commentCard}>
      <strong className={css.commentAuthor}>{comment.author?.login}</strong>
      <DshCompactMarkdownText text={comment.body} labels={labels} />
    </article>
  )
}

/** Detail head and body: number, title, state tags, browser shortcut, markdown. */
export function RemoteDetailSection({ detail, labels, t, children }: {
  readonly detail: RemotePull | RemoteIssue
  readonly labels: MarkdownLabels
  readonly t: (key: GitLocaleKey) => string
  readonly children?: ReactNode
}): ReactNode {
  const head = 'head' in detail ? detail.head : undefined
  const base = 'base' in detail ? detail.base : undefined
  const meta = useMemo(() => {
    if (head === undefined || base === undefined) return undefined
    return `${head.repository?.owner ?? ''}:${head.ref} → ${base.repository?.owner ?? ''}:${base.ref} · ${head.sha.slice(0, 12)}`
  }, [head, base])
  return (
    <section className={css.section} aria-label={`#${detail.number}`}>
      <div className={css.detailHeader}>
        <h4 className={css.detailTitle}>#{detail.number} {detail.title}</h4>
        <span className={css.detailTags}>
          {'draft' in detail && detail.draft && <Tag tone="quiet">{t('remote.draft')}</Tag>}
          <Tag tone={detailStateTone(detail.state)}>{t(detailStateKey(detail.state))}</Tag>
          {detail.url === undefined ? null : (
            <Tooltip label={t('remote.openBrowser')} side="top" delayMs={200}>
              <a
                className={css.iconLink}
                href={detail.url}
                target="_blank"
                rel="noreferrer"
                aria-label={t('remote.openBrowser')}
              >
                <IconRightUpOutline16 size={14} />
              </a>
            </Tooltip>
          )}
        </span>
      </div>
      {meta === undefined ? null : <p className={css.detailMeta}>{meta}</p>}
      <div className={css.detailBody}>
        <DshCompactMarkdownText text={detail.body} labels={labels} />
      </div>
      {children}
    </section>
  )
}
