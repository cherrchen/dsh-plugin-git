/** GitHub avatar with an initial-letter fallback; opaque so the timeline gutter never shows through. */
import { useState } from 'react'
import type { ReactNode } from 'react'
import css from '../GitRemoteSurface.module.css'

export function RemoteAvatar({ login, url, size }: {
  readonly login: string | undefined
  readonly url: string | undefined
  readonly size: number
}): ReactNode {
  const [failed, setFailed] = useState(false)
  let src: string | undefined
  if (url !== undefined) {
    try {
      const parsed = new URL(url)
      parsed.searchParams.set('s', String(size * 2))
      src = parsed.href
    } catch { src = undefined }
  }
  return (
    <span className={css.avatar} style={{ width: size, height: size, fontSize: Math.max(9, size / 2) }} aria-hidden="true">
      {src !== undefined && !failed
        ? <img className={css.avatarImg} src={src} alt="" width={size} height={size} loading="lazy" referrerPolicy="no-referrer" onError={() => { setFailed(true) }} />
        : login?.slice(0, 1).toUpperCase() ?? '?'}
    </span>
  )
}
