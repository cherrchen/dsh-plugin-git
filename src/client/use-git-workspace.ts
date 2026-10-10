/** Shared workspace binding for Git details surfaces and composer controls. */
import { useEffect } from 'react'
import type { GitClientController } from './controller.ts'

/**
 * Bind the controller's repository discovery to the session's effective directory
 * and reload whenever it changes, so the surface cannot keep operating on the
 * previous checkout.
 * @param controller - Git controller for this session.
 * @param workspacePath - Effective session directory, if any.
 */
export function useGitWorkspace(controller: GitClientController, workspacePath: string | undefined): void {
  useEffect(() => {
    void controller.setWorkspace(workspacePath)
  }, [controller, workspacePath])
}
