import { useState } from 'react'
import type { ReactNode } from 'react'
import { DisclosureRow, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RemoteComment, RemoteFile, RemotePage } from '../../remote/provider.ts'
import { remoteDiff, type RemoteDiffAnchor } from '../../remote/diff.ts'
import { IconGitFile } from './icons.tsx'
import type { GitLocaleKey } from '../locales.ts'
import css from '../GitRemoteSurface.module.css'

/** One changed file: disclosure head plus patch lines carrying comment anchors. */
function RemoteFileDiff({ file, baseSha, headSha, anchor, onSelectAnchor, t }: {
  readonly file: RemoteFile
  readonly baseSha: string
  readonly headSha: string
  readonly anchor: RemoteDiffAnchor | undefined
  readonly onSelectAnchor: (next: RemoteDiffAnchor, extend: boolean) => void
  readonly t: (key: GitLocaleKey) => string
}): ReactNode {
  const [open, setOpen] = useState(false)
  const diff = remoteDiff(file, baseSha, headSha)
  return (
    <DisclosureRow
      icon={<IconGitFile size={14} />}
      title={file.path}
      open={open}
      expandable={diff.lines.length > 0}
      onToggle={() => { setOpen(value => !value) }}
      collapsedContent={(
        <span className={css.diffStats}>
          <span className={css.diffAdd}>+{file.additions}</span>
          <span className={css.diffDelete}>−{file.deletions}</span>
        </span>
      )}
    >
      <div className={css.diffLines}>
        {!diff.safe && <p className={css.note}>{t('remote.unsafeInline')}</p>}
        {diff.lines.map((line, index) => line.anchor === undefined
          ? (
            <span key={index} className={css.diffLine} data-kind={line.kind}>{line.text}</span>
          )
          : (
            <button
              key={index}
              type="button"
              className={css.diffLine}
              data-kind={line.kind}
              aria-pressed={anchor?.path === file.path && anchor.line === line.anchor.line && anchor.side === line.anchor.side}
              onClick={(event) => { onSelectAnchor(line.anchor!, event.shiftKey) }}
            >
              <span className={css.diffGutter}>{line.oldLine ?? ' '}</span>
              <span className={css.diffGutter}>{line.newLine ?? ' '}</span>
              {line.text}
            </button>
          ))}
      </div>
    </DisclosureRow>
  )
}

/** Changed-file comparisons and the flat inline-comment list. */
export function RemoteComparisonFiles({ files, baseSha, headSha, anchor, onSelectAnchor, inline, labels, t }: {
  readonly files: RemotePage<RemoteFile>
  readonly baseSha: string
  readonly headSha: string
  readonly anchor: RemoteDiffAnchor | undefined
  readonly onSelectAnchor: (next: RemoteDiffAnchor, extend: boolean) => void
  readonly inline: readonly RemoteComment[]
  readonly labels: MarkdownLabels
  readonly t: (key: GitLocaleKey) => string
}): ReactNode {
  return (
    <section className={css.section} aria-label={t('remote.filesChanged')}>
      <h3 className={css.sectionHead}>
        <span className={css.sectionTitle}>
          {t('remote.filesChanged')}
          <span className={css.sectionCount}>{files.items.length}</span>
        </span>
      </h3>
      {files.items.map(file => (
        <RemoteFileDiff
          key={file.path}
          file={file}
          baseSha={baseSha}
          headSha={headSha}
          anchor={anchor}
          onSelectAnchor={onSelectAnchor}
          t={t}
        />
      ))}
      {inline.length === 0 ? null : (
        <>
          <h3 className={css.sectionHead}>
            <span className={css.sectionTitle}>
              {t('remote.inlineComments')}
              <span className={css.sectionCount}>{inline.length}</span>
            </span>
          </h3>
          {inline.map(comment => (
            <article key={comment.id} className={css.commentCard}>
              <strong className={css.commentAuthor}>
                {comment.author?.login}
                <span className={css.commentRef}> · {comment.path ?? ''}:{comment.line ?? '—'}</span>
                {comment.outdated && <span className={css.commentRef}> · {t('remote.outdated')}</span>}
                {comment.replyTo !== undefined && <span className={css.commentRef}> ↳ {comment.replyTo}</span>}
              </strong>
              <MarkdownText text={comment.body} labels={labels} variant="compact" />
            </article>
          ))}
        </>
      )}
    </section>
  )
}
