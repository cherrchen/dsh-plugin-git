/** Check that the DSH compatibility contract matches the manifest and install. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function caretFloor(range, label) {
  const match = /^[~^](\d+\.\d+\.\d+)$/u.exec(range ?? '')
  if (!match) {
    failures.push(`${label} must be a single caret or tilde range; found ${range ?? '(missing)'}`)
    return undefined
  }
  return match[1]
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

/** Whether `>=x.y.z <a.b.c` accepts an exact version. */
function rangeAllows(range, version) {
  const match = /^>=(\d+\.\d+\.\d+) <(\d+\.\d+\.\d+)$/u.exec(range ?? '')
  if (!match) return false
  return compareVersions(version, match[1]) >= 0 && compareVersions(version, match[2]) < 0
}

function readHostRuntime(require) {
  try {
    const settings = require('@deepseek-ai/dsh-settings/package.json')
    return {
      settings: settings.version,
      schemasteryRange: settings.peerDependencies?.['@deepseek-ai/schemastery'],
      cordisRange: settings.peerDependencies?.['@deepseek-ai/cordis'],
      schemastery: require('@deepseek-ai/schemastery/package.json').version,
      cordis: require('@deepseek-ai/cordis/package.json').version,
    }
  } catch {
    return {}
  }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { lockfileDrift } = require('./dsh-release-wave.cjs')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const contract = readFileSync(join(root, 'src/compat/dsh-version.ts'), 'utf8')
const match = /export const SUPPORTED_DSH_RELEASES = \[([^\]]*)\]/u.exec(contract)
if (!match) throw new Error('SUPPORTED_DSH_RELEASES must be an array literal in src/compat/dsh-version.ts')
const supported = [...match[1].matchAll(/'([^']+)'/gu)].map((item) => item[1])
if (supported.length === 0) throw new Error('SUPPORTED_DSH_RELEASES must not be empty')
if (process.argv.includes('--list')) {
  console.log(JSON.stringify(supported))
  process.exit(0)
}

if (process.argv.includes('--list-non-default')) {
  const pins = new Set(Object.entries(manifest.devDependencies ?? {})
    .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
    .map(([, version]) => version))
  if (pins.size !== 1) throw new Error(`development dependencies must pin one DSH release; found ${[...pins].join(', ') || '(none)'}`)
  const [pin] = pins
  if (!supported.includes(pin)) throw new Error(`development pin ${pin} is not in the supported release list`)
  console.log(JSON.stringify(supported.filter(version => version !== pin)))
  process.exit(0)
}

const peers = Object.fromEntries(Object.entries(manifest.peerDependencies ?? {}).filter(([name]) => name.startsWith('@deepseek-ai/dsh-')))
const devs = Object.fromEntries(Object.entries(manifest.devDependencies ?? {}).filter(([name]) => name.startsWith('@deepseek-ai/dsh-')))
const expectedPeerRange = supported.join(' || ')
const failures = []
const notes = []
const candidateMode = process.env.DSH_COMPAT_MODE === 'warn'
const candidateVersion = process.env.DSH_COMPAT_VERSION

console.log(`[compat] supported DSH releases: ${supported.join(', ')}`)

for (const [name, range] of Object.entries(peers)) {
  if (range !== expectedPeerRange && !candidateMode) failures.push(`peerDependencies[${name}] is ${range}; expected ${expectedPeerRange}`)
  if (!(name in devs)) failures.push(`${name} is a peer dependency but has no development pin`)
}

const pins = new Set(Object.values(devs))
if (pins.size !== 1) failures.push(`development dependencies must pin one DSH release; found ${[...pins].join(', ') || '(none)'}`)
const pin = [...pins][0]
if (pin !== undefined) {
  if (candidateMode) {
    if (!candidateVersion || pin !== candidateVersion) failures.push(`candidate pin ${pin} does not match DSH_COMPAT_VERSION ${candidateVersion ?? '(unset)'}`)
    else notes.push(`candidate pin: ${pin} (not yet supported)`)
  } else if (!supported.includes(pin)) failures.push(`development pin ${pin} is not in the supported release list`)
  else notes.push(`development pin: ${pin}`)
}

const packages = new Set([...Object.keys(peers), ...Object.keys(devs)])
const installedVersions = new Map()
for (const name of packages) {
  try {
    installedVersions.set(name, require(`${name}/package.json`).version)
  } catch {
    installedVersions.set(name, undefined)
  }
}
for (const [name, version] of installedVersions) {
  if (version === undefined) failures.push(`${name} is declared but not installed; run pnpm install`)
  else if (version !== pin) failures.push(`${name} resolves to ${version}, while the development pin is ${pin}`)
}

if (pin !== undefined) {
  const lockText = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')
  for (const drift of lockfileDrift(lockText, pin)) failures.push(drift)
}

// The DSH packages declare the cordis and schemastery copies a real host of
// this release ships. A newer copy that still satisfies a caret or tilde hides
// load crashes that only happen on that host (schemastery 3.18.2 has no volatile).
const hostRuntime = readHostRuntime(require)
if (hostRuntime.settings === undefined) {
  failures.push('@deepseek-ai/dsh-settings is not installed; the host runtime pin cannot be checked')
} else {
  const schemaFloor = caretFloor(hostRuntime.schemasteryRange, '@deepseek-ai/dsh-settings peer @deepseek-ai/schemastery')
  const cordisFloor = caretFloor(hostRuntime.cordisRange, '@deepseek-ai/dsh-settings peer @deepseek-ai/cordis')
  if (schemaFloor !== undefined && hostRuntime.schemastery !== schemaFloor) {
    failures.push(`@deepseek-ai/schemastery resolves to ${hostRuntime.schemastery ?? '(missing)'}, while ${hostRuntime.settings} ships ${schemaFloor}`)
  }
  if (cordisFloor !== undefined && hostRuntime.cordis !== cordisFloor) {
    failures.push(`@deepseek-ai/cordis resolves to ${hostRuntime.cordis ?? '(missing)'}, while ${hostRuntime.settings} ships ${cordisFloor}`)
  }
  if (schemaFloor !== undefined && !rangeAllows(manifest.dependencies?.['@deepseek-ai/schemastery'], schemaFloor)) {
    failures.push(`dependencies[@deepseek-ai/schemastery] ${manifest.dependencies?.['@deepseek-ai/schemastery']} does not accept the host copy ${schemaFloor}`)
  }
  if (cordisFloor !== undefined && !rangeAllows(manifest.peerDependencies?.['@deepseek-ai/cordis'], cordisFloor)) {
    failures.push(`peerDependencies[@deepseek-ai/cordis] ${manifest.peerDependencies?.['@deepseek-ai/cordis']} does not accept the host copy ${cordisFloor}`)
  }
}

for (const note of notes) console.log(`[compat] ${note}`)
if (failures.length) {
  console.error('\n[compat] DSH compatibility contract failed:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(candidateMode
  ? '[compat] the unlisted candidate is installed consistently; review validation before promotion'
  : '[compat] supported list, peer dependencies, development pins and installed packages agree')
