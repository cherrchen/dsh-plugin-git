import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { RemotePending } from '../remote.ts'
import type { GitLocaleKey } from '../locales.ts'
import css from '../GitRemoteSurface.module.css'

const labels: Record<RemotePending, GitLocaleKey> = {
  repositories: 'remote.loadingRemotes',
  repository: 'remote.connecting',
  items: 'remote.loadingItems',
  detail: 'remote.loadingDetail',
  auth: 'remote.loadingAuth',
  authorization: 'remote.waitingAuth',
  write: 'remote.saving',
}

/** Keep network activity visible without replacing the content being read. */
export function RemoteLoading({ pending, streaming = false, t }: {
  readonly pending?: RemotePending | undefined
  readonly streaming?: boolean
  readonly t: (key: GitLocaleKey) => string
}): ReactNode {
  const active = pending !== undefined || streaming
  const waitingForUser = pending === 'authorization'
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    setSlow(false)
    if (!active || waitingForUser) return
    const timer = setTimeout(() => { setSlow(true) }, 8000)
    return () => clearTimeout(timer)
  }, [active, waitingForUser])
  if (!active) return null
  return <div className={css.loadingStatus} role="status" aria-live="polite">
    <span className={css.spinner} aria-hidden="true" />
    <div className={css.loadingText}>
      <span>{t(pending === undefined ? 'remote.loadingMore' : labels[pending])}</span>
      {slow && <span className={css.loadingSlow}>{t('remote.slowConnection')}</span>}
    </div>
  </div>
}

export function RemoteListSkeleton(): ReactNode {
  return <div className={css.skeletonList} aria-hidden="true" data-git-remote-skeleton="">
    {[0, 1, 2, 3].map(row => <div className={css.skeletonRow} key={row}>
      <span className={css.skeletonTitle} />
      <span className={css.skeletonMeta} />
    </div>)}
  </div>
}
