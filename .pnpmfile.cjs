/**
 * Force every transitive @deepseek-ai/dsh-* edge onto the release under test.
 *
 * Upstream publishes those edges as caret ranges. A later prerelease of the
 * same core then satisfies the range, so the installed tree is no longer the
 * release the lane claims to verify. DSH_COMPAT_VERSION selects the matrix
 * lane; otherwise the root devDependency pin is the target.
 *
 * The root manifest keeps its devDependency pins and its multi-version peer
 * OR ranges. Those are the compatibility contract, not an upstream caret.
 */
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { developmentPin, pinDshDependencies } = require('./scripts/dsh-release-wave.cjs')

const root = __dirname
const compatibilitySource = readFileSync(join(root, 'src/compat/dsh-version.ts'), 'utf8')
const releases = name => [...compatibilitySource.match(new RegExp('export const ' + name + ' = \\[([^\\]]*)\\]'))[1].matchAll(/'([^']+)'/g)].map(item => item[1])
const supportedReleases = releases('SUPPORTED_DSH_RELEASES')
const credentialReleases = releases('CREDENTIALS_SEAM_DSH_RELEASES')
const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

function targetVersion() {
  const fromEnv = process.env.DSH_COMPAT_VERSION
  if (fromEnv) return fromEnv
  return developmentPin(rootManifest)
}

function isRootPackage(pkg, context) {
  const dir = typeof context === 'string' ? context : context?.dir
  if (dir && join(dir) === root) return true
  return pkg?.name === rootManifest.name
}

function readPackage(pkg, context) {
  const version = targetVersion()
  if (isRootPackage(pkg, context) && supportedReleases.includes(version) && !credentialReleases.includes(version)) {
    // pnpm installs a root peer as a direct edge even when optional. Omit only
    // this development-lane edge; the published manifest remains unchanged.
    if (pkg.peerDependencies) delete pkg.peerDependencies['@deepseek-ai/dsh-credentials']
  }
  return pinDshDependencies(pkg, version, {
    skipPeerDependencies: isRootPackage(pkg, context),
  })
}

module.exports = {
  hooks: {
    readPackage,
  },
}
