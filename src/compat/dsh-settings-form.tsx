/** Bridge the shared settings-form frame across the releases that define it. */
import * as Primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsFormProps } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ComponentType } from 'react'

const exports = Primitives as unknown as Record<string, ComponentType<SettingsFormProps> | undefined>

/**
 * The shared settings-page frame, resolved by presence: hosts before DSH
 * 0.1.7 serve `plugins.bundle.config` pages without exporting it, so callers
 * fall back to a local frame with the same chrome.
 */
export const NativeSettingsForm = exports.SettingsForm
