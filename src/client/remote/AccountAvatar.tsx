/** Shared identity mark: the viewer's avatar image or the generic person glyph. */
import type { ReactNode } from 'react'
import type { GitRemoteViewer } from '../../remote/types.ts'
import { IconUserOutline16 } from '../../compat/dsh-icons.tsx'
import { RemoteAvatar } from './RemoteAvatar.tsx'
import css from './AccountAvatar.module.css'

export function AccountAvatar({ viewer, size = 32 }: { readonly viewer: Pick<GitRemoteViewer, 'login' | 'avatarUrl'> | undefined; readonly size?: number }): ReactNode {
  if (viewer !== undefined) return <RemoteAvatar login={viewer.login} url={viewer.avatarUrl} size={size} />
  return <span className={css.fallback} style={{ width: size, height: size }} aria-hidden="true"><IconUserOutline16 size={16} /></span>
}
