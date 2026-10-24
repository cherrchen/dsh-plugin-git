import { useEffect, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { GitRemoteFeature } from '../../src/client/remote.ts'
import { RemoteAuthControl } from '../../src/client/remote/RemoteAuthControl.tsx'
import { en, zh, type GitLocaleKey } from '../../src/client/locales.ts'
import './theme.css'

const params = new URLSearchParams(location.search)
const locale = params.get('lang') === 'en' ? en : zh
const { id, repository } = await fetch('/__test/fixture', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ scenario: params.get('scenario') ?? 'gh' }),
}).then(response => response.json())
const feature = new GitRemoteFeature({ call: async (_channel, endpoint, payload, signal) => {
  return fetch('/__test/rpc', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, endpoint, payload }), ...(signal === undefined ? {} : { signal }),
  }).then(response => response.json())
} })
const controller = feature.controllerFor(id)
controller.setRepository(repository, false)
feature.start()
window.addEventListener('pagehide', () => feature.dispose(), { once: true })
function App() {
  const capability = useSyncExternalStore(feature.subscribe, feature.getSnapshot)
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const generation = capability.state === 'on' ? capability.generation.revision : undefined
  useEffect(() => { void controller.ensureList() }, [generation])
  return <main>
    <h1>Isolated Git authentication</h1>
    <p>Temporary repository and credentials · simulated GitHub service</p>
    <output aria-label="Fixture ID">{id}</output>
    {capability.state === 'on' && <RemoteAuthControl capability={capability} viewer={state.facts?.viewer}
      busy={state.busy} controller={controller} t={(key: GitLocaleKey) => locale[key]} />}
  </main>
}
createRoot(document.getElementById('root')!).render(<App />)
