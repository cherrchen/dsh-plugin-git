/**
 * Combined plugin-manager card: `plugins.bundle.config` is keyed by package
 * name, so the bundle page gets ONE registration hosting both Git sections —
 * commit-message generation and Worktrees — side by side.
 */
import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { CommitMessageSettingsCardController } from './commit-message-card-controller.ts'
import { CommitMessageSettingsCard } from './CommitMessageSettingsCard.tsx'
import type { WorktreeSettingsCardController } from './worktree-card-controller.ts'
import { WorktreeSettingsCard } from './WorktreeSettingsCard.tsx'

/** Props the renderer binds for the bundle-level settings card. */
export type GitBundleConfigCardProps =
  PropsLocale<'git'>
  & {
    commitMessage: CommitMessageSettingsCardController
    worktrees: WorktreeSettingsCardController
    /** Plugin-manager view: `summary` renders one line per section; `page` renders both forms. */
    view?: 'summary' | 'page'
  }

/**
 * Render both Git settings sections on the plugin's bundle page.
 * @param props - injected section controllers, locale copy, and the host view.
 * @returns The two section cards (or their summaries) stacked.
 */
export function GitBundleConfigCard({ commitMessage, worktrees, view, t }: GitBundleConfigCardProps): ReactNode {
  const viewProp = view === undefined ? {} : { view }
  return (
    <>
      <CommitMessageSettingsCard controller={commitMessage} t={t} {...viewProp} />
      <WorktreeSettingsCard controller={worktrees} t={t} {...viewProp} />
    </>
  )
}
