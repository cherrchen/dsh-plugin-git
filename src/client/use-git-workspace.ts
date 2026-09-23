/** Shared workspace binding for Git details surfaces and composer controls. */
import { useEffect } from 'react'
import type { GitClientController } from './controller.ts'

/**
 * Bind the controller's repository discovery to the current session workspace
 * and reload whenever it changes (workspace/session switches rebind, so no
 * surface can keep showing a previous workspace's repository).
 * @param controller - Shared Git client controller.
 * @param workspacePath - Current workspace path (session cwd), if any.
 */
export function useGitWorkspace(controller: GitClientController, workspacePath: string | undefined): void {
  useEffect(() => {
    void controller.setWorkspace(workspacePath)
  }, [controller, workspacePath])
}
