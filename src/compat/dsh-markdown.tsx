/** Optional Markdown presentation across supported host primitives. */
import type { ComponentProps, ReactNode } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'

// Older MarkdownText implementations ignore this optional presentation hint.
// Spread it separately so their declarations need only the shared text/labels API.
const compactPresentation = { variant: 'compact' } as const

export function DshCompactMarkdownText(props: Pick<ComponentProps<typeof MarkdownText>, 'text' | 'labels'>): ReactNode {
  return <MarkdownText {...compactPresentation} {...props} />
}
