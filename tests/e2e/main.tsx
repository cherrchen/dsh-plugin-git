import { useEffect, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { GitRemoteFeature } from '../../src/client/remote.ts'
import { GitSessionControllers } from '../../src/client/session-controllers.ts'
import { RemoteAccountsSettings } from '../../src/client/settings/RemoteAccountsSettings.tsx'
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
  body: JSON.stringify({ scenario: params.get('scenario') ?? 'gh', outcome: params.get('outcome') ?? 'success', fixtureId: params.get('fixture') }),
}).then(response => response.json())
const rpc = { call: async (_channel: string, endpoint: string, payload: unknown, signal?: AbortSignal) => {
  return fetch('/__test/rpc', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, endpoint, payload }), ...(signal === undefined ? {} : { signal }),
  }).then(response => response.json())
} }
const feature = new GitRemoteFeature(rpc)
// Native calls are captured, never sent to a real system browser or clipboard.
const nativeEvents: string[] = []
const showNativeEvents = () => { document.getElementById('native-events')!.textContent = JSON.stringify(nativeEvents) }
if (params.get('desktop') !== null) feature.setAuthDesktop({
  openExternal: async url => {
    nativeEvents.push(`open:${url}`); showNativeEvents()
    if (params.get('desktop') === 'fail') throw new Error('Fixture browser failure')
  },
  copyText: async text => {
    nativeEvents.push(`copy:${text}`); showNativeEvents()
    if (params.get('clipboard') === 'fail') throw new Error('Fixture clipboard failure')
  },
})
// The isolated /rpc endpoint only serves remote-* endpoints, so the local
// session controller is stubbed to report the fixture checkout directly.
const localSnapshot = Object.freeze({ repository: { root: repository }, loading: false })
const localController = {
  subscribe() { return () => {} },
  getSnapshot() { return localSnapshot },
  async setWorkspace() {}, async refresh() {},
  setPushObserver() {}, setDesktop() {}, setDiffNavigator() {}, dispose() {},
}
const gitSessions = { controllerFor: () => localController, dispose() {} } as unknown as GitSessionControllers
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
  useEffect(() => { if (params.get('view') !== 'settings') void list.ensureList() }, [generation])
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
    <output id="native-events" aria-label="Native events" />
    <button type="button" onClick={() => { feature.setAuthDesktop(undefined) }}>Unload native fixture</button>
    {params.get('view') === 'settings' ? <RemoteAccountsSettings feature={feature} t={t} /> : gitlab ? <>
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
