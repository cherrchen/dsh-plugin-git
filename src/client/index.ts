/** Portable Git client slots with an optional structural Desktop enhancement. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { GitRemoteFeature, gitLabNoticeKeys, remoteNoticeKeys } from './remote.ts'
import type { RemoteTarget } from './remote/remote-view.ts'
import { GitRemoteSurface, GitRemoteTitle } from './surfaces/GitRemoteSurface.tsx'
import { GitRemoteItemSurface } from './surfaces/GitRemoteItemSurface.tsx'
import { GitBranchControl } from './GitBranchControl.tsx'
import { GitDetailsHeaderActions } from './GitDetailsHeaderActions.tsx'
import { GitChangesSurface } from './surfaces/GitChangesSurface.tsx'
import { GitDiffSurface } from './surfaces/GitDiffSurface.tsx'
import { GitPageTitle } from './GitPageTitle.tsx'
import { GitGraphSurface } from './surfaces/GitGraphSurface.tsx'
import { GitWorktreesSurface } from './surfaces/GitWorktreesSurface.tsx'
import type { GitDesktopCapability } from './controller.ts'
import { GitSessionControllers } from './session-controllers.ts'
import { GitWorktreeFeature } from './worktree-feature.ts'
import {
  CommitMessageSettingsCardController,
  GIT_COMMIT_MESSAGE_SETTINGS_NAMESPACE,
  type CommitMessageCardSettings,
  type CommitMessageSettingsForm,
  type CommitMessageCatalogGroup,
  type CommitMessageCatalogLoader,
} from './settings/commit-message-card-controller.ts'
import { CommitMessageSettingsCard } from './settings/CommitMessageSettingsCard.tsx'
import { GitBundleConfigCard } from './settings/GitBundleConfigCard.tsx'
import { WorktreeSettingsCard } from './settings/WorktreeSettingsCard.tsx'
import {
  GIT_WORKTREE_SETTINGS_NAMESPACE,
  WorktreeSettingsCardController,
  type WorktreeCardSettings,
} from './settings/worktree-card-controller.ts'
import {
  GIT_CHANGES_ID,
  GIT_CHANGES_KIND,
  GIT_DIFF_ID,
  GIT_DIFF_KIND,
  GIT_GRAPH_ID,
  GIT_GRAPH_KIND,
  GIT_WORKTREES_ID,
  GIT_WORKTREES_KIND,
  GIT_REMOTE_ITEM_ID,
  gitDiffAddress,
  gitRemoteItemAddress,
} from './contract.ts'

import { changesDefinition, diffDefinition, graphDefinition, worktreesDefinition, remoteDefinition, remoteItemDefinition } from './tab-definitions.ts'
import { en, NS, zh, type GitLocaleKey } from './locales.ts'
import { injectDshGitSettings } from '../compat/dsh-client-settings.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    git: GitLocaleKey
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    desktop: GitDesktopCapability
  }
}

export { GitBranchControl, GitDetailsHeaderActions, GitChangesSurface, GitDiffSurface, GitGraphSurface }
export {
  GIT_CHANGES_ID,
  GIT_CHANGES_KIND,
  GIT_DIFF_ID,
  GIT_DIFF_KIND,
  GIT_GRAPH_ID,
  GIT_GRAPH_KIND,
  GIT_WORKTREES_ID,
  GIT_WORKTREES_KIND,
  gitDiffAddress,
  parseGitDiffAddress,
  type GitChangesPayload,
  type GitDiffMode,
  type GitDiffPayload,
  type GitGraphPayload,
  type GitWorktreesPayload,
} from './contract.ts'
export { GitClientController, type GitCommitFollowUp, type GitCommitOptions, type GitDesktopCapability } from './controller.ts'
export { GitWorktreeFeature } from './worktree-feature.ts'

export const inject = ['slots', 'connection', 'locale', 'sidebarRight', 'sidebarRightTabs']

/** Register portable UI first, then activate native enhancement in an optional child fiber. */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  const worktreeFeature = new GitWorktreeFeature(connection.rpc)
  ctx.effect(() => () => { worktreeFeature.dispose() }, 'git: worktree feature')
  const gitSessions = new GitSessionControllers(connection.rpc, worktreeFeature)
  ctx.effect(() => () => { gitSessions.dispose() }, 'git: session controllers')

  // Unified navigation: every Git entry point (composer chip, changes rows,
  // guide) converges on the right sidebar. Changes and Graph are singleton
  // pages; a diff opens as a resource whose exact address is its tab identity,
  // so re-opening a file reveals its tab instead of duplicating it.
  const openChanges = (): void => {
    ctx.sidebarRight.openTab(GIT_CHANGES_KIND)
  }
  const openWorktrees = (): void => {
    ctx.sidebarRight.openTab(GIT_WORKTREES_KIND)
  }
  const openDiff = (path: string, staged: boolean): void => {
    ctx.sidebarRight.openResource(gitDiffAddress(path, staged), { params: { path, staged } })
  }
  gitSessions.setDiffNavigator(openDiff)
  // A pull/issue opens as a resource tab whose address is the remote identity;
  // one shared body renders either kind from the navigation payload.
  const openRemoteItem = (target: RemoteTarget, kind: 'pulls' | 'issues', number: number): void => {
    const params = target.provider === 'gitlab'
      ? { provider: 'gitlab' as const, instance: target.instance, path: target.path, kind, number }
      : { owner: target.owner, repo: target.repo, kind, number }
    ctx.sidebarRight.openResource(gitRemoteItemAddress(target, kind, number), { params })
  }

  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'git: dictionaries')
  const t = ctx.locale.bind(NS)
  const remoteFeature = new GitRemoteFeature(connection.rpc)
  gitSessions.setPushObserver((repository, head, sessionId, remoteName) => { void remoteFeature.pushed(repository, head, sessionId, t('remote.pushedSuggestion'), remoteName, () => gitSessions.controllerFor(sessionId).getSnapshot().repository?.root === repository) })
  let remoteTabDispose: (() => void) | undefined
  const remoteSurfaces: (() => void)[] = []
  ctx.effect(() => {
    const unsubscribe = remoteFeature.subscribe(() => {
      if (remoteFeature.getSnapshot().state === 'on' && remoteTabDispose === undefined) {
        remoteSurfaces.push(ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: 'git.remote', locale: NS, inject: () => ({ gitSessions, remoteFeature, openRemoteItem }) }, GitRemoteSurface)))
        remoteSurfaces.push(ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: GIT_REMOTE_ITEM_ID, locale: NS, inject: () => ({ gitSessions, remoteFeature }) }, GitRemoteItemSurface)))
        remoteSurfaces.push(ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: 'git.remote', locale: NS, inject: () => ({ remoteFeature }) }, GitRemoteTitle)))
        remoteTabDispose = ctx.sidebarRightTabs.register(remoteDefinition(t))
        remoteSurfaces.push(ctx.sidebarRightTabs.register(remoteItemDefinition(t)))
      } else if (remoteFeature.getSnapshot().state === 'off') { remoteTabDispose?.(); remoteTabDispose = undefined; remoteSurfaces.splice(0).forEach(dispose => dispose()) }
    })
    remoteFeature.start()
    return () => { unsubscribe(); remoteTabDispose?.(); remoteSurfaces.splice(0).forEach(dispose => dispose()); remoteFeature.dispose() }
  }, 'git: remote lifecycle')
  ctx.effect(() => ctx.sidebarRightTabs.register(changesDefinition(t)), 'git: changes tab type')
  ctx.effect(() => ctx.sidebarRightTabs.register(diffDefinition()), 'git: diff tab type')
  ctx.effect(() => ctx.sidebarRightTabs.register(graphDefinition(t)), 'git: graph tab type')

  // The Worktrees tab type exists only while the host reports a creation mode:
  // the upstream runtime mounted, or the local fallback enabled in settings.
  // Its body and title stay registered — they render only when a tab exists.
  let worktreeTabDispose: (() => void) | undefined
  ctx.effect(() => {
    const unsubscribe = worktreeFeature.subscribe(() => {
      const mode = worktreeFeature.getSnapshot().mode
      if (mode === 'upstream' || mode === 'local') {
        worktreeTabDispose ??= ctx.sidebarRightTabs.register(worktreesDefinition(t))
      } else if (mode === 'off') {
        worktreeTabDispose?.()
        worktreeTabDispose = undefined
      }
    })
    return () => {
      unsubscribe()
      worktreeTabDispose?.()
      worktreeTabDispose = undefined
    }
  }, 'git: worktrees tab type')
  worktreeFeature.startPolling()

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'git-context',
    locale: NS,
    inject: () => ({ gitSessions, openDetails: openChanges }),
  }, GitBranchControl))

  // Stage two: one body per tab type, keyed by the definition id. The sidebar
  // tab bar dispatches every tab of a kind to its registered body.
  const bodies: ReadonlyArray<{ key: string; component: typeof GitChangesSurface; inject: () => Record<string, unknown> }> = [
    { key: GIT_CHANGES_ID, component: GitChangesSurface, inject: () => ({ gitSessions, openWorktrees }) },
    { key: GIT_DIFF_ID, component: GitDiffSurface, inject: () => ({ gitSessions }) },
    { key: GIT_GRAPH_ID, component: GitGraphSurface, inject: () => ({ gitSessions }) },
    { key: GIT_WORKTREES_ID, component: GitWorktreesSurface, inject: () => ({ gitSessions, worktreeFeature }) },
  ]
  for (const body of bodies) {
    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab',
      key: body.key,
      locale: NS,
      inject: body.inject,
    }, body.component)), `git: ${body.key} body`)
  }

  // Diff chips title themselves after the compared file — path text, language
  // neutral — so only the page types need a live-title registration.
  const pageTitles: ReadonlyArray<{ key: string; label: GitLocaleKey }> = [
    { key: GIT_CHANGES_ID, label: 'tab.changes' },
    { key: GIT_GRAPH_ID, label: 'tab.graph' },
    { key: GIT_WORKTREES_ID, label: 'tab.worktrees' },
  ]
  for (const entry of pageTitles) {
    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab.title',
      key: entry.key,
      locale: NS,
      inject: () => ({ labelKey: entry.label }),
    }, GitPageTitle)), `git: ${entry.key} title`)
  }

  ctx.inject(['desktop'], (desktopCtx) => {
    gitSessions.setDesktop(desktopCtx.desktop)
    remoteFeature.setAuthDesktop({
      ...(typeof desktopCtx.desktop.shell.openExternal === 'function' ? { openExternal: (url: string) => desktopCtx.desktop.shell.openExternal!(url) } : {}),
      ...(typeof desktopCtx.desktop.clipboard?.writeText === 'function' ? { copyText: (text: string) => desktopCtx.desktop.clipboard!.writeText(text) } : {}),
    })
    remoteFeature.setNotify(async notice => {
      const label = (notice.provider === 'gitlab' ? gitLabNoticeKeys : remoteNoticeKeys)[notice.kind]
      await desktopCtx.desktop.notification.show({ title: t('remote.title'), body: `${t(label)} · ${notice.title}` })
    })
    return () => { gitSessions.setDesktop(undefined); remoteFeature.setNotify(undefined); remoteFeature.setAuthDesktop(undefined) }
  })

  const mountCommitMessageSettings = (
    settingsCtx: ClientContext,
    getForm: () => CommitMessageSettingsForm<CommitMessageCardSettings>,
  ): { inject: () => { controller: CommitMessageSettingsCardController } } => {
    const loadCatalog: CommitMessageCatalogLoader = async () => {
      const session = settingsCtx.get('remote.session') as {
        modelCatalog?: () => Promise<
          | { ok: true; value: { groups: readonly CommitMessageCatalogGroup[]; failures: readonly unknown[] } }
          | { ok: false }
        >
      } | undefined
      if (session?.modelCatalog === undefined) return undefined
      const response = await session.modelCatalog()
      if (!response.ok) return undefined
      return { groups: response.value.groups, partial: response.value.failures.length > 0 }
    }
    const card = new CommitMessageSettingsCardController(
      getForm(),
      loadCatalog,
    )
    settingsCtx.effect(() => () => { card.dispose() }, 'git: commit-message settings dispose')
    return { inject: () => ({ controller: card }) }
  }

  const mountWorktreeSettings = (
    settingsCtx: ClientContext,
    getForm: () => CommitMessageSettingsForm<WorktreeCardSettings>,
  ): { inject: () => { controller: WorktreeSettingsCardController } } => {
    const card = new WorktreeSettingsCardController(getForm(), () => { worktreeFeature.refresh() })
    settingsCtx.effect(() => () => { card.dispose() }, 'git: worktrees settings dispose')
    return { inject: () => ({ controller: card }) }
  }

  // Settings API and slot differences across DSH releases are isolated in compat.
  injectDshGitSettings(ctx, {
    entryId: 'dsh-plugin-git',
    bundleKey: '@dsh-electron/dsh-plugin-git',
    locale: NS,
    commitMessage: {
      namespace: GIT_COMMIT_MESSAGE_SETTINGS_NAMESPACE,
      configPath: 'commitMessage',
      component: CommitMessageSettingsCard,
      mount: mountCommitMessageSettings,
    },
    worktrees: {
      namespace: GIT_WORKTREE_SETTINGS_NAMESPACE,
      configPath: 'worktrees',
      component: WorktreeSettingsCard,
      mount: mountWorktreeSettings,
    },
    bundleComponent: GitBundleConfigCard,
    bundleInject: () => ({ remoteFeature }),
  })
}
