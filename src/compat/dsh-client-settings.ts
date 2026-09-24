/** Adapt the commit-message settings APIs exposed across supported DSH releases. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {
  CommitMessageCardSettings,
  CommitMessageSettingsForm,
} from '../client/settings/commit-message-card-controller.ts'

/**
 * Bundle configuration key: the package name. Hosts from 0.1.6-alpha.2 render
 * it on the bundle's page in plugin management, between the description and the rows.
 */
const GIT_PLUGIN_BUNDLE_CONFIG_KEY = '@dsh-electron/dsh-plugin-git'

/** What one settings fiber contributes to every settings surface the host declares. */
interface CommitMessageSettingsSurface {
  /** Slot inject payload. The card reads `controller` and ignores host-supplied form props. */
  inject: () => { controller: unknown }
}

interface SettingsSlots {
  inject(name: string, callback: () => void | (() => void)): () => void
  register(options: Record<string, unknown>, component: unknown): () => void
}

/**
 * Register the card on every settings surface this package supports.
 * Hosts that do not declare a slot leave that `inject` pending, so each
 * supported release renders only the surface it owns.
 * @param settingsCtx - fiber that provides a settings read/write API.
 * @param options - namespace, locale, component, and the live inject payload.
 */
function registerCommitMessageSurfaces(
  settingsCtx: ClientContext,
  options: {
    namespace: string
    locale: string
    component: unknown
    surface: CommitMessageSettingsSurface
  },
): void {
  const slots = settingsCtx.slots as unknown as SettingsSlots
  settingsCtx.effect(() => slots.inject('settings.plugin.item', () => slots.register({
    name: 'settings.plugin.item',
    key: options.namespace,
    locale: options.locale,
    inject: options.surface.inject,
  }, options.component)), 'git: commit-message settings card')
  settingsCtx.effect(() => slots.inject('plugins.bundle.config', () => slots.register({
    name: 'plugins.bundle.config',
    key: GIT_PLUGIN_BUNDLE_CONFIG_KEY,
    locale: options.locale,
    inject: options.surface.inject,
  }, options.component)), 'git: commit-message bundle config')
}

/** Attach the settings card to the legacy namespace API and the Config form API when available. */
export function injectDshCommitMessageSettings(
  ctx: ClientContext,
  options: {
    namespace: string
    entryId: string
    locale: string
    component: unknown
    mount: (
      settingsCtx: ClientContext,
      getForm: () => CommitMessageSettingsForm<CommitMessageCardSettings>,
    ) => CommitMessageSettingsSurface
  },
): void {
  const inject = (ctx as unknown as {
    inject(services: string[], callback: (settingsCtx: ClientContext) => unknown): unknown
  }).inject.bind(ctx)

  const attach = (
    settingsCtx: ClientContext,
    getForm: () => CommitMessageSettingsForm<CommitMessageCardSettings>,
  ): void => {
    registerCommitMessageSurfaces(settingsCtx, {
      namespace: options.namespace,
      locale: options.locale,
      component: options.component,
      surface: options.mount(settingsCtx, getForm),
    })
  }

  inject(['settingsScope'], (settingsCtx) => {
    const settingsApi = settingsCtx as unknown as {
      settingsScope: {
        bind(options: { namespace: string }): CommitMessageSettingsForm<CommitMessageCardSettings>
      }
    }
    attach(settingsCtx, () => settingsApi.settingsScope.bind({ namespace: options.namespace }))
  })

  inject(['configForms'], (settingsCtx) => {
    const settingsApi = settingsCtx as unknown as {
      configForms: {
        get(entryId: string): CommitMessageSettingsForm<Record<string, unknown>>
      }
    }
    attach(settingsCtx, () => {
      const form = settingsApi.configForms.get(options.entryId)
      return {
        getSnapshot: () => {
          const snapshot = form.getSnapshot()
          return {
            ...snapshot,
            value: snapshot.value?.commitMessage as CommitMessageCardSettings | undefined,
          }
        },
        subscribe: listener => form.subscribe(listener),
        mutate: (operations, revision) => form.mutate(operations.map(operation => ({
          ...operation,
          path: ['commitMessage', ...operation.path],
        })), revision),
      }
    })
  })
}
