/** Pin every transitive @deepseek-ai/dsh-* edge to one exact release. */

const DSH_PREFIX = '@deepseek-ai/dsh-'
const PIN_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies']

function developmentPin(manifest) {
  const pins = [...new Set(Object.entries(manifest.devDependencies ?? {})
    .filter(([name]) => name.startsWith(DSH_PREFIX))
    .map(([, version]) => version))]
  if (pins.length !== 1) {
    throw new Error(`[dsh-pin] development dependencies must pin one DSH release; found ${pins.join(', ') || '(none)'}`)
  }
  return pins[0]
}

function pinDshDependencies(pkg, target, options = {}) {
  const fields = options.skipPeerDependencies
    ? PIN_FIELDS.filter(field => field !== 'peerDependencies')
    : PIN_FIELDS
  for (const field of fields) {
    const deps = pkg[field]
    if (!deps) continue
    for (const name of Object.keys(deps)) {
      if (!name.startsWith(DSH_PREFIX) || typeof deps[name] !== 'string') continue
      deps[name] = target
    }
  }
  return pkg
}

/** Package entries in pnpm-lock.yaml, ignoring snapshot keys that carry peer suffixes. */
function lockfileDshPackages(lockText) {
  const packagesAt = lockText.indexOf('\npackages:\n')
  if (packagesAt === -1) return []
  const snapshotsAt = lockText.indexOf('\nsnapshots:\n', packagesAt)
  const section = lockText.slice(packagesAt, snapshotsAt === -1 ? undefined : snapshotsAt)
  const found = []
  for (const match of section.matchAll(/^  '(@deepseek-ai\/dsh-[^@']+)@([^'(]+)':$/gm)) {
    found.push({ name: match[1], version: match[2] })
  }
  return found
}

function lockfileDrift(lockText, pin) {
  return lockfileDshPackages(lockText)
    .filter(entry => entry.version !== pin)
    .map(entry => `${entry.name}\n    expected: ${pin}\n    resolved: ${entry.version}`)
}

module.exports = {
  DSH_PREFIX,
  developmentPin,
  pinDshDependencies,
  lockfileDshPackages,
  lockfileDrift,
}
