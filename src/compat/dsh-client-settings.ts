/** Adapt the plugin settings APIs exposed across supported DSH releases. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {
  CommitMessageCardSettings,
  CommitMessageSettingsForm,
} from '../client/settings/commit-message-card-controller.ts'
import type { WorktreeCardSettings } from '../client/settings/worktree-card-controller.ts'

/** What one mounted section contributes to a settings surface. */
interface SettingsSurface {
  /** Slot inject payload. The card reads `controller` and ignores host-supplied form props. */
  inject: () => { controller: unknown }
}

interface SettingsSlots {
  inject(name: string, callback: () => void | (() => void)): () => void
  register(options: Record<string, unknown>, component: unknown): () => void
}

/** One namespaced settings section the plugin publishes. */
interface SettingsSection<T> {
  /** Namespace for the legacy `settings.plugin.item` keyed surface. */
  readonly namespace: string
  /** Property inside the plugin's Config object the `configForms` surface edits. */
  readonly configPath: string
  /** Card component for the namespace surface. */
  readonly component: unknown
  /**
   * Build the section's live surface inside one settings fiber.
   * @param settingsCtx - fiber that provides a settings read/write API.
   * @param getForm - resolves the section-bound form on demand.
   * @returns The inject payload factory plus any scoped teardown.
   */
  readonly mount: (
    settingsCtx: ClientContext,
    getForm: () => CommitMessageSettingsForm<T>,
  ) => SettingsSurface
}

/**
 * Project a `configForms` plugin-level form onto one Config property.
 * Reads and writes flow through the same revision-fenced mutation API, with
 * every op path prefixed by the section's property name.
 * @param form - The plugin's whole-Config form.
 * @param section - Config property this card owns.
 * @returns A section-shaped form for the card controller.
 */
function configSectionForm<T>(
  form: CommitMessageSettingsForm<Record<string, unknown>>,
  section: string,
): CommitMessageSettingsForm<T> {
  return {
    getSnapshot: () => {
      const snapshot = form.getSnapshot()
      return {
        ...snapshot,
        value: snapshot.value?.[section] as T | undefined,
      }
    },
    subscribe: listener => form.subscribe(listener),
    mutate: (operations, revision) => form.mutate(operations.map(operation => ({
      ...operation,
      path: [section, ...operation.path],
    })), revision),
  }
}

/**
 * Register every section on every settings surface this package supports.
 * `settings.plugin.item` is keyed by namespace, so each section gets its own
 * card; `plugins.bundle.config` is keyed by package name, so all sections
 * compose into ONE registration there (a second same-key entry would shadow
 * or clash). Hosts that do not declare a slot leave that `inject` pending, so
 * each supported release renders only the surfaces it owns.
 * @param settingsCtx - fiber that provides a settings read/write API.
 * @param options - locale, bundle key, sections, and the combined bundle component.
 */
function registerSettingsSurfaces(
  settingsCtx: ClientContext,
  options: {
    locale: string
    bundleKey: string
    commitMessage: SettingsSection<CommitMessageCardSettings>
    worktrees: SettingsSection<WorktreeCardSettings>
    bundleComponent: unknown
    bundleInject?: () => Record<string, unknown>
  },
  forms: {
    commitMessage: () => CommitMessageSettingsForm<CommitMessageCardSettings>
    worktrees: () => CommitMessageSettingsForm<WorktreeCardSettings>
  },
): void {
  const commitSurface = options.commitMessage.mount(settingsCtx, forms.commitMessage)
  const worktreeSurface = options.worktrees.mount(settingsCtx, forms.worktrees)
  const slots = settingsCtx.slots as unknown as SettingsSlots
  for (const section of [
    { spec: options.commitMessage, surface: commitSurface },
    { spec: options.worktrees, surface: worktreeSurface },
  ] as const) {
    settingsCtx.effect(() => slots.inject('settings.plugin.item', () => slots.register({
      name: 'settings.plugin.item',
      key: section.spec.namespace,
      locale: options.locale,
      inject: section.surface.inject,
    }, section.spec.component)), `git: ${section.spec.namespace} settings card`)
  }
  settingsCtx.effect(() => slots.inject('plugins.bundle.config', () => slots.register({
    name: 'plugins.bundle.config',
    key: options.bundleKey,
    locale: options.locale,
    inject: () => ({
      ...options.bundleInject?.(),
      commitMessage: commitSurface.inject().controller,
      worktrees: worktreeSurface.inject().controller,
    }),
  }, options.bundleComponent)), 'git: bundle config card')
}

/**
 * Attach every settings section to the legacy namespace API and the Config
 * form API when available.
 * @param ctx - Client plugin context.
 * @param options - Section descriptors plus the combined bundle card component.
 */
export function injectDshGitSettings(
  ctx: ClientContext,
  options: {
    locale: string
    /** `configForms` entry id: the Loader composition name. */
    entryId: string
    /** `plugins.bundle.config` key: the published package name. */
    bundleKey: string
    commitMessage: SettingsSection<CommitMessageCardSettings>
    worktrees: SettingsSection<WorktreeCardSettings>
    /** Component rendering both injected controllers (`commitMessage`, `worktrees`) plus `view`. */
    bundleComponent: unknown
    bundleInject?: () => Record<string, unknown>
  },
): void {
  const inject = (ctx as unknown as {
    inject(services: string[], callback: (settingsCtx: ClientContext) => unknown): unknown
  }).inject.bind(ctx)

  inject(['settingsScope'], (settingsCtx) => {
    const settingsApi = settingsCtx as unknown as {
      settingsScope: {
        bind(options: { namespace: string }): CommitMessageSettingsForm<never>
      }
    }
    registerSettingsSurfaces(settingsCtx, options, {
      commitMessage: () => settingsApi.settingsScope.bind({ namespace: options.commitMessage.namespace }),
      worktrees: () => settingsApi.settingsScope.bind({ namespace: options.worktrees.namespace }),
    })
  })

  inject(['configForms'], (settingsCtx) => {
    const settingsApi = settingsCtx as unknown as {
      configForms: {
        get(entryId: string): CommitMessageSettingsForm<Record<string, unknown>>
      }
    }
    registerSettingsSurfaces(settingsCtx, options, {
      commitMessage: () => configSectionForm<CommitMessageCardSettings>(
        settingsApi.configForms.get(options.entryId),
        options.commitMessage.configPath,
      ),
      worktrees: () => configSectionForm<WorktreeCardSettings>(
        settingsApi.configForms.get(options.entryId),
        options.worktrees.configPath,
      ),
    })
  })
}
