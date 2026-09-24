/**
 * Point every DSH development dependency, plus the cordis and schemastery
 * copies that release ships, at one exact upstream version.
 *
 * The script edits package.json and the schemastery override in
 * pnpm-workspace.yaml. The caller installs afterwards. It does
 * not change SUPPORTED_DSH_RELEASES or peer ranges: a green matrix lane is
 * evidence, not a support promise.
 *
 * Cordis and schemastery are pinned to the caret floor declared by that DSH
 * release (`@deepseek-ai/dsh` and `@deepseek-ai/dsh-settings`). Leaving the
 * baseline 4.0.2 / 3.18.2 pins in a 0.1.7 tree, or floating a newer copy into
 * a 0.1.5 tree, makes the lane pass against a runtime the host does not ship.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(root, 'package.json')
const workspacePath = join(root, 'pnpm-workspace.yaml')

const version = process.argv[2]
if (!version || !/^\d+\.\d+\.\d+-(?:alpha|beta|rc)\.\d+$/u.test(version)) {
  console.error('Usage: node scripts/upgrade-dsh.mjs <prerelease-version>')
  process.exit(2)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

function view(spec) {
  const raw = execFileSync('npm', ['view', spec, '--json'], { encoding: 'utf8' })
  return JSON.parse(raw)
}

function caretFloor(range, label) {
  const match = typeof range === 'string' ? /^\^(\d+\.\d+\.\d+)$/u.exec(range) : null
  if (match === null) {
    throw new Error(`[upgrade] ${label} is ${JSON.stringify(range)}, which is not a single caret this script can pin`)
  }
  return match[1]
}

const dshView = view(`@deepseek-ai/dsh@${version}`)
const cordisVersion = caretFloor(
  dshView?.dependencies?.['@deepseek-ai/cordis'],
  `@deepseek-ai/dsh@${version} cordis`,
)
const settingsView = view(`@deepseek-ai/dsh-settings@${version}`)
const schemasteryVersion = caretFloor(
  settingsView?.['peerDependencies.@deepseek-ai/schemastery']
    ?? settingsView?.peerDependencies?.['@deepseek-ai/schemastery'],
  `@deepseek-ai/dsh-settings@${version} schemastery`,
)

const packages = Object.keys(manifest.devDependencies ?? {}).filter(name => name.startsWith('@deepseek-ai/dsh-'))
if (packages.length === 0) throw new Error('No DSH development dependencies found')

let changed = 0
for (const name of packages) {
  if (manifest.devDependencies[name] === version) continue
  manifest.devDependencies[name] = version
  changed += 1
}
if (manifest.devDependencies['@deepseek-ai/cordis'] !== cordisVersion) {
  manifest.devDependencies['@deepseek-ai/cordis'] = cordisVersion
  changed += 1
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
const workspace = readFileSync(workspacePath, 'utf8')
const overrideLine = /^(\s*'@deepseek-ai\/schemastery': )\S+$/m
if (!overrideLine.test(workspace)) {
  throw new Error('[upgrade] pnpm-workspace.yaml has no @deepseek-ai/schemastery override to repoint')
}
writeFileSync(workspacePath, workspace.replace(overrideLine, `$1${schemasteryVersion}`))
console.log(`[upgrade] DSH packages set to ${version} (${changed} manifest entries changed)`)
console.log(`[upgrade] cordis pin: ${cordisVersion}`)
console.log(`[upgrade] schemastery pin: ${schemasteryVersion}`)
console.log('[upgrade] next: pnpm install --no-frozen-lockfile')
