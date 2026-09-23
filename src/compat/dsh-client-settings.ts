/** Adapt the commit-message settings APIs exposed across supported DSH releases. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {
  CommitMessageCardSettings,
  CommitMessageSettingsForm,
} from '../client/settings/commit-message-card-controller.ts'

/** Attach the settings card to the legacy namespace API and the Config form API when available. */
export function injectDshCommitMessageSettings(
  ctx: ClientContext,
  options: {
    namespace: string
    entryId: string
    mount: (settingsCtx: ClientContext, getForm: () => CommitMessageSettingsForm<CommitMessageCardSettings>) => void
  },
): void {
  const inject = (ctx as unknown as {
    inject(services: string[], callback: (settingsCtx: ClientContext) => unknown): unknown
  }).inject.bind(ctx)

  inject(['settingsScope'], (settingsCtx) => {
    const settingsApi = settingsCtx as unknown as {
      settingsScope: {
        bind(options: { namespace: string }): CommitMessageSettingsForm<CommitMessageCardSettings>
      }
    }
    options.mount(settingsCtx, () => settingsApi.settingsScope.bind({ namespace: options.namespace }))
  })

  inject(['configForms'], (settingsCtx) => {
    const settingsApi = settingsCtx as unknown as {
      configForms: {
        get(entryId: string): CommitMessageSettingsForm<Record<string, unknown>>
      }
    }
    options.mount(settingsCtx, () => {
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
