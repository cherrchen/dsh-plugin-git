/**
 * Stage one of the Git tab-type registrations: what each type IS.
 *
 * Changes and Graph are page types (opened by kind, no address claimed); Diff
 * is a resource type over `dsh-resource://git/diff/...`, where the exact
 * address is the tab identity, so re-opening a file reveals its tab. Guide
 * entries replace the old Details launcher cards.
 */
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import {
  GIT_CHANGES_ID,
  GIT_CHANGES_KIND,
  GIT_DIFF_ID,
  GIT_DIFF_KIND,
  GIT_GRAPH_ID,
  GIT_GRAPH_KIND,
  GIT_WORKTREES_ID,
  GIT_WORKTREES_KIND,
  GIT_DIFF_RESOURCE_PROTOCOL,
  GIT_REMOTE_ITEM_ID,
  GIT_REMOTE_ITEM_KIND,
  GIT_REMOTE_ITEM_RESOURCE_PROTOCOL,
  parseGitDiffAddress,
  parseGitRemoteItemAddress,
} from './contract.ts'
import { splitRepoPath } from './path-display.ts'
import { BranchGlyph, GraphGlyph, RemoteGlyph, WorktreeGlyph } from './LauncherIcons.tsx'

// The host places workspace files at 10 and the new-terminal entry at 20.
const GUIDE_ORDER = { changes: 11, graph: 12, worktrees: 13, remote: 14 } as const

/**
 * The Changes page type, plus its guide entry.
 * @param t - Namespace-bound translate, read fresh on every label call.
 * @returns The definition to register.
 */
export function changesDefinition(t: TranslateNS<'git'>): SidebarRightTabDefinition {
  const guideEntry = {
    id: 'git-changes',
    order: GUIDE_ORDER.changes,
    title: () => t('launcher.changes.title'),
    description: () => t('launcher.changes.description'),
    icon: BranchGlyph,
  }
  return {
    id: GIT_CHANGES_ID,
    kind: GIT_CHANGES_KIND,
    title: () => t('tab.changes'),
    guide: [guideEntry],
  }
}

/**
 * The Diff resource type: claims the Git diff address grammar and titles tabs
 * after the changed file.
 */
export function diffDefinition(): SidebarRightTabDefinition {
  return {
    id: GIT_DIFF_ID,
    kind: GIT_DIFF_KIND,
    patterns: [`dsh-resource://${GIT_DIFF_RESOURCE_PROTOCOL}/diff/**`],
    canOpen: address => parseGitDiffAddress(address) !== undefined,
    title: address => {
      const payload = parseGitDiffAddress(address)
      return payload === undefined ? 'Diff' : splitRepoPath(payload.path).name
    },
  }
}

/**
 * The Graph page type, plus its guide entry.
 * @param t - Namespace-bound translate, read fresh on every label call.
 * @returns The definition to register.
 */
export function graphDefinition(t: TranslateNS<'git'>): SidebarRightTabDefinition {
  const guideEntry = {
    id: 'git-graph',
    order: GUIDE_ORDER.graph,
    title: () => t('launcher.graph.title'),
    description: () => t('launcher.graph.description'),
    icon: GraphGlyph,
  }
  return {
    id: GIT_GRAPH_ID,
    kind: GIT_GRAPH_KIND,
    title: () => t('tab.graph'),
    guide: [guideEntry],
  }
}

/**
 * The Worktrees page type, plus its guide entry.
 * Registration is gated on the host-reported worktree feature mode; this
 * definition itself carries no availability logic.
 * @param t - Namespace-bound translate, read fresh on every label call.
 * @returns The definition to register.
 */
export function worktreesDefinition(t: TranslateNS<'git'>): SidebarRightTabDefinition {
  const guideEntry = {
    id: 'git-worktrees',
    order: GUIDE_ORDER.worktrees,
    title: () => t('launcher.worktrees.title'),
    description: () => t('launcher.worktrees.description'),
    icon: WorktreeGlyph,
  }
  return {
    id: GIT_WORKTREES_ID,
    kind: GIT_WORKTREES_KIND,
    title: () => t('tab.worktrees'),
    guide: [guideEntry],
  }
}


/** Remote page; keep guide metadata in a structural local value for older sidebar schemas. */
export function remoteDefinition(t: TranslateNS<'git'>): SidebarRightTabDefinition {
  const entry = { id: 'git-remote', order: GUIDE_ORDER.remote, title: () => t('remote.title'), description: () => t('remote.description'), icon: RemoteGlyph }
  return { id: 'git.remote', kind: 'git.remote', title: () => t('remote.title'), guide: [entry] }
}

/**
 * Remote pull/issue detail resource type: one shared body renders either item
 * kind, and the address's owner/repo/kind/number is the tab identity.
 */
export function remoteItemDefinition(t: TranslateNS<'git'>): SidebarRightTabDefinition {
  return {
    id: GIT_REMOTE_ITEM_ID,
    kind: GIT_REMOTE_ITEM_KIND,
    patterns: [`dsh-resource://${GIT_REMOTE_ITEM_RESOURCE_PROTOCOL}/**`],
    canOpen: address => parseGitRemoteItemAddress(address) !== undefined,
    title: address => {
      const payload = parseGitRemoteItemAddress(address)
      if (payload === undefined) return t('remote.title')
      return t(payload.kind === 'pulls' ? 'remote.tabPull' : 'remote.tabIssue', { number: payload.number })
    },
  }
}
