/** Markdown rendering for remote bodies: GitHub HTML is normalized first, `<details>` becomes a native disclosure. */
import { useMemo } from 'react'
import type { ReactNode } from 'react'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import { DshCompactMarkdownText } from '../../compat/dsh-markdown.tsx'
import { githubBlocks, type GitHubBlock } from './github-markdown.ts'
import css from '../GitRemoteSurface.module.css'

function Blocks({ blocks, labels, detailsLabel }: {
  readonly blocks: readonly GitHubBlock[]
  readonly labels: MarkdownLabels
  readonly detailsLabel: string
}): ReactNode {
  return (
    <>
      {blocks.map((block, index) => block.kind === 'markdown' ? (
        <DshCompactMarkdownText key={index} text={block.text} labels={labels} />
      ) : (
        <details key={index} className={css.mdDetails} open={block.open}>
          <summary className={css.mdSummary}>
            {block.summary === '' ? detailsLabel : <DshCompactMarkdownText text={block.summary} labels={labels} />}
          </summary>
          <div className={css.mdDetailsBody}>
            <Blocks blocks={block.children} labels={labels} detailsLabel={detailsLabel} />
          </div>
        </details>
      ))}
    </>
  )
}

export function RemoteMarkdown({ text, labels, detailsLabel }: {
  readonly text: string
  readonly labels: MarkdownLabels
  readonly detailsLabel: string
}): ReactNode {
  const blocks = useMemo(() => githubBlocks(text), [text])
  return <Blocks blocks={blocks} labels={labels} detailsLabel={detailsLabel} />
}
