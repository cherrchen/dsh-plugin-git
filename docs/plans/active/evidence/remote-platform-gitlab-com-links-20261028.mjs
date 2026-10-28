/** Offline replay of GitLab.com's captured pagination links; no credentials/network. */
import { readFile } from 'node:fs/promises'
import { GitRemoteHttpError, gitLabContinuation } from '../../../../src/remote/http.ts'

const evidence = JSON.parse(await readFile(new URL('./remote-platform-gitlab-com-20261028.json', import.meta.url), 'utf8'))
const results = []
for (const observation of evidence.paginationObservations) {
  const links = observation.headers.link
  if (typeof links !== 'string') continue
  for (const part of links.split(',')) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="([a-z]+)"\s*$/u.exec(part)
    if (match === null) throw new Error('Captured Link header is malformed')
    try {
      gitLabContinuation('https://gitlab.com', observation.path, match[1], match[2] === 'next' ? 'next' : 'any')
      results.push({ path: observation.path, relation: match[2], accepted: true })
    } catch (error) {
      results.push({ path: observation.path, relation: match[2], accepted: false, kind: error instanceof GitRemoteHttpError ? error.kind : 'unexpected' })
    }
  }
}
console.log(JSON.stringify({ externalNetwork: false, credentials: false, results }, null, 2))
// The acceptance invariant is that genuine server pagination metadata is usable.
// The original A3 baseline exits 1; repaired code must exit 0 and preserve hostile-link rejection.
if (results.length === 0 || results.some(result => !result.accepted)) process.exitCode = 1
