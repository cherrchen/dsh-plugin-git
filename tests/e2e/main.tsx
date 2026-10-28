import { useEffect, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { GitRemoteFeature } from '../../src/client/remote.ts'
import { GitSessionControllers } from '../../src/client/session-controllers.ts'
import { RemoteAuthControl } from '../../src/client/remote/RemoteAuthControl.tsx'
import { GitRemoteSurface } from '../../src/client/surfaces/GitRemoteSurface.tsx'
import { GitRemoteItemSurface } from '../../src/client/surfaces/GitRemoteItemSurface.tsx'
import { gitRemoteItemAddress, type GitRemoteItemPayload } from '../../src/client/contract.ts'
import type { RemoteTarget } from '../../src/client/remote/remote-view.ts'
import { en, zh, type GitLocaleKey } from '../../src/client/locales.ts'
import './theme.css'

const params = new URLSearchParams(location.search)
const locale = params.get('lang') === 'en' ? en : zh
const t = (key: GitLocaleKey): string => locale[key]
const { id, repository } = await fetch('/__test/fixture', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ scenario: params.get('scenario') ?? 'gh' }),
}).then(response => response.json())
const rpc = { call: async (_channel: string, endpoint: string, payload: unknown, signal?: AbortSignal) => {
  return fetch('/__test/rpc', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, endpoint, payload }), ...(signal === undefined ? {} : { signal }),
  }).then(response => response.json())
} }
const feature = new GitRemoteFeature(rpc)
const gitSessions = new GitSessionControllers(rpc)
const list = feature.controllerFor(id)
list.setRepository(repository, false)
feature.start()
window.addEventListener('pagehide', () => feature.dispose(), { once: true })
interface Navigation { address: string; params: GitRemoteItemPayload; revision: number }
function App() {
  const capability = useSyncExternalStore(feature.subscribe, feature.getSnapshot)
  const state = useSyncExternalStore(list.subscribe, list.getSnapshot)
  const [navigation, setNavigation] = useState<Navigation>()
  const generation = capability.state === 'on' ? capability.generation.revision : undefined
  useEffect(() => { void list.ensureList() }, [generation])
  const gitlab = (params.get('scenario') ?? '').startsWith('gitlab')
  const openRemoteItem = (target: RemoteTarget, kind: 'pulls' | 'issues', number: number): void => {
    const payload: GitRemoteItemPayload = target.provider === 'gitlab'
      ? { provider: 'gitlab', instance: target.instance, path: target.path, kind, number }
      : { owner: target.owner, repo: target.repo, kind, number }
    setNavigation(current => ({ address: gitRemoteItemAddress(target, kind, number), params: payload, revision: (current?.revision ?? 0) + 1 }))
  }
  const useSessions = (selector: (value: unknown) => unknown): unknown => selector({ byId: { [id]: { cwd: repository } } })
  return <main>
    <h1>Isolated Git authentication</h1>
    <p>Temporary repository and credentials · simulated GitHub service</p>
    <output aria-label="Fixture ID">{id}</output>
    {gitlab ? <>
      <button type="button" onClick={() => { void feature.pushed(repository, 'a'.repeat(40), id, 'Fixture GitHub push', 'origin') }}>Simulate local push event</button>
      <button type="button" onClick={() => { void list.pollNotices() }}>Run notification fixture</button>
      <GitRemoteSurface {...{ gitSessions, remoteFeature: feature, openRemoteItem, sessionId: id, useSessions, t } as never} />
      {navigation !== undefined && (
        <GitRemoteItemSurface {...{ gitSessions, remoteFeature: feature, sessionId: id, useSessions, useTabInfo: () => ({ tab: { navigation } }), t } as never} />
      )}
    </> : capability.state === 'on' && <RemoteAuthControl capability={capability} viewer={state.facts?.viewer}
      busy={state.busy} controller={list} t={t} />}
  </main>
}
createRoot(document.getElementById('root')!).render(<App />)
