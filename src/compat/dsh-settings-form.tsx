/** Bridge the shared settings-form frame across the releases that define it. */
import * as Primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { ComponentType, ReactNode } from 'react'

/**
 * The copy the form frame renders, from this plugin's dictionary. Mirrors the
 * host's `SettingsFormLabels`; declared locally because hosts before DSH
 * 0.1.7 do not export the types either.
 */
export interface GitSettingsFormLabels {
  /** Shown in place of the controls while no namespace is served. */
  unavailable: string
  /** Shown over the controls while the document is read-only. */
  readOnly: string
  /** Shown beside the save after a save the host did not accept. */
  saveFailed: string
  /** The save control. */
  save: string
  /** The save control while a save is crossing the wire. */
  saving: string
}

/** Form state the frame reads; mirrors the host's `SettingsFormShell`. */
export interface GitSettingsFormShell {
  /** False while no namespace is served; the frame renders the unavailable line. */
  available: boolean
  /** Whether the served documents accept writes. */
  writable: boolean
  /** Whether the form holds edits a save would write. */
  dirty: boolean
  /** Whether any staged draft blocks the save. */
  invalid: boolean
  /** Whether a save is crossing the wire. */
  saving: boolean
  /** Whether the last save did not land as staged. */
  failed: boolean
}

/** Frame props identical to the host's `SettingsFormProps` (DSH >=0.1.7). */
export interface GitSettingsFormProps {
  /** The frame's copy. */
  labels: GitSettingsFormLabels
  /** The form state: availability, writability, and what a save would do. */
  state: GitSettingsFormShell
  /** Write every staged edit. */
  onSave: () => void
  /** Drop every staged edit; the frame calls it when it leaves the page. */
  onDiscard: () => void
  /** The plugin's controls. */
  children: ReactNode
}

const exports = Primitives as unknown as Record<string, ComponentType<GitSettingsFormProps> | undefined>

/**
 * The shared settings-page frame, resolved by presence: hosts before DSH
 * 0.1.7 serve `plugins.bundle.config` pages without exporting it, so callers
 * fall back to a local frame with the same chrome.
 */
export const NativeSettingsForm = exports.SettingsForm
