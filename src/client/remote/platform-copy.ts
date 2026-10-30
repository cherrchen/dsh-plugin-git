import type { GitLocaleKey } from '../locales.ts'
import type { RemoteTarget } from './remote-view.ts'

/** Reuse the discovered target's provider; discovery itself has no platform yet. */
export function platformCopy(t: (key: GitLocaleKey) => string, key: GitLocaleKey, provider?: RemoteTarget['provider']): string {
  const platform = provider === 'github' ? 'GitHub' : provider === 'gitlab' ? 'GitLab' : t('remote.platform')
  return t(key).replaceAll('{platform}', platform)
}
