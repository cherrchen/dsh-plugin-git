import type { ReactNode } from 'react'
import type { RemoteNotice } from '../../remote/provider.ts'
import { remoteNoticeKeys, gitLabNoticeKeys } from '../remote.ts'
import type { GitLocaleKey } from '../locales.ts'
import css from '../GitRemoteSurface.module.css'

type ClientNotice = RemoteNotice & { readonly provider?: 'gitlab' }

/** Notice rows fed by notification polling, also counted in the tab title. */
export function RemoteNotices({ notices, t }: {
  readonly notices: readonly ClientNotice[]
  readonly t: (key: GitLocaleKey) => string
}): ReactNode {
  if (notices.length === 0) return null
  return (
    <>
      {notices.map(notice => (
        <p key={notice.id} className={css.notice} role="status">
          {t((notice.provider === 'gitlab' ? gitLabNoticeKeys : remoteNoticeKeys)[notice.kind])} · {notice.title}
        </p>
      ))}
    </>
  )
}
