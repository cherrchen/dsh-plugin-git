import { useEffect, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { GitRemoteFeature } from '../../src/client/remote.ts'
import { RemoteAuthControl } from '../../src/client/remote/RemoteAuthControl.tsx'
import { GitLabRemotePanel } from '../../src/client/remote/GitLabRemotePanel.tsx'
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
const gitlab = feature.gitlabControllerFor(id)
controller.setRepository(repository, false)
feature.start()
window.addEventListener('pagehide', () => feature.dispose(), { once: true })
function App() {
  const capability = useSyncExternalStore(feature.subscribe, feature.getSnapshot)
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const generation = capability.state === 'on' ? capability.generation.revision : undefined
  useEffect(() => { if (!(params.get('scenario') ?? '').startsWith('gitlab')) void controller.ensureList() }, [generation])
  return <main>
    <h1>Isolated Git authentication</h1>
    <p>Temporary repository and credentials · simulated GitHub service</p>
    <output aria-label="Fixture ID">{id}</output>
    {(params.get('scenario') ?? '').startsWith('gitlab') ? <><button type="button" onClick={() => { void feature.pushed(repository, 'a'.repeat(40), id, 'Fixture GitHub push', 'origin') }}>Simulate local push event</button><button type="button" onClick={() => { void gitlab.pollNotices() }}>Run notification fixture</button><GitLabRemotePanel controller={gitlab} repository={repository} t={(key: GitLocaleKey) => locale[key]} /></> : capability.state === 'on' && <RemoteAuthControl capability={capability} viewer={state.facts?.viewer}
      busy={state.busy} controller={controller} t={(key: GitLocaleKey) => locale[key]} />}
  </main>
}
createRoot(document.getElementById('root')!).render(<App />)
