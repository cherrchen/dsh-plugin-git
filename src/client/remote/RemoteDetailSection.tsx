import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { Tag, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconRightUpOutline16 } from '../../compat/dsh-icons.tsx'
import type { RemoteItem } from './remote-view.ts'
import type { GitLocaleKey } from '../locales.ts'
import { RemoteMarkdown } from './RemoteMarkdown.tsx'
import { GitLabMarkdown } from './GitLabMarkdown.tsx'
import { RemoteAvatar } from './RemoteAvatar.tsx'
import css from '../GitRemoteSurface.module.css'

/** Localized chrome for every MarkdownText on this page. */
export function remoteMarkdownLabels(t: (key: GitLocaleKey) => string): MarkdownLabels {
  return {
    code: { copyLabel: t('remote.copy'), copiedLabel: t('remote.copied') },
    footnotes: t('remote.footnotes'),
  }
}

function detailStateKey(state: RemoteItem['state']): GitLocaleKey {
  if (state === 'closed') return 'remote.stateClosed'
  if (state === 'merged') return 'remote.stateMerged'
  if (state === 'unknown') return 'remote.stateUnknown'
  return 'remote.stateOpen'
}

function detailStateTone(state: RemoteItem['state']): 'success' | 'neutral' | 'info' | 'warning' {
  if (state === 'closed') return 'neutral'
  if (state === 'merged') return 'info'
  if (state === 'unknown') return 'warning'
  return 'success'
}

/** Detail head and opening post: number, title, state tags, browser shortcut, then the description as the first timeline card. */
export function RemoteDetailSection({ detail, labels, instance, t, children }: {
  readonly detail: RemoteItem
  readonly labels: MarkdownLabels
  /** GitLab canonical instance; enables GitLab link projection in Markdown bodies. */
  readonly instance?: string | undefined
  readonly t: (key: GitLocaleKey) => string
  readonly children?: ReactNode
}): ReactNode {
  const head = 'head' in detail ? detail.head : undefined
  const base = 'base' in detail ? detail.base : undefined
  const meta = useMemo(() => {
    if (head === undefined || base === undefined) return undefined
    if ('repository' in head || 'repository' in base) {
      const left = 'repository' in head ? head : undefined
      const right = 'repository' in base ? base : undefined
      if (left === undefined || right === undefined || left.sha === null || right.sha === null) return undefined
      return `${left.repository?.owner ?? ''}:${left.ref} → ${right.repository?.owner ?? ''}:${right.ref} · ${left.sha.slice(0, 12)}`
    }
    const headSha = head.sha === null ? '—' : head.sha.slice(0, 12)
    return `${head.projectId ?? '—'}:${head.ref} → ${base.projectId ?? '—'}:${base.ref} · ${headSha}`
  }, [head, base])
  const body = detail.body === ''
    ? <p className={css.tlEmpty}>{t('remote.noDescription')}</p>
    : instance === undefined
      ? <RemoteMarkdown text={detail.body} labels={labels} detailsLabel={t('remote.details')} />
      : <GitLabMarkdown text={detail.body} instance={instance} detailsLabel={t('remote.details')} />
  return (
    <section className={css.section} aria-label={`#${detail.number}`}>
      <div className={css.detailHeader}>
        <h4 className={css.detailTitle}>#{detail.number} {detail.title}</h4>
        <span className={css.detailTags}>
          {'draft' in detail && detail.draft === true && <Tag tone="quiet">{t('remote.draft')}</Tag>}
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
      <div className={css.tlItem}>
        <span className={css.tlAvatar}><RemoteAvatar login={detail.author?.login} url={detail.author?.avatarUrl} size={20} /></span>
        <article className={css.tlCard}>
          <header className={css.tlCardHead}>
            <strong>{detail.author?.login}</strong>
            <span className={css.tlMeta}>{t('remote.opened')}</span>
            {detail.createdAt !== undefined && (
              <time className={css.tlMeta} dateTime={detail.createdAt} title={detail.createdAt}>{detail.createdAt.slice(0, 10)}</time>
            )}
            {detail.url === undefined ? null : (
              <Tooltip label={t('remote.openBrowser')} side="top" delayMs={200}>
                <a className={css.iconLink} href={detail.url} target="_blank" rel="noreferrer" aria-label={t('remote.openBrowser')}>
                  <IconRightUpOutline16 size={14} />
                </a>
              </Tooltip>
            )}
          </header>
          <div className={css.tlCardBody}>{body}</div>
        </article>
      </div>
      {children}
    </section>
  )
}
