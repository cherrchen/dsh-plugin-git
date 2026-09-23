/** Move every DSH development dependency to one explicitly selected candidate. */
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const version = process.argv[2]
if (!version || !/^\d+\.\d+\.\d+-(?:alpha|beta|rc)\.\d+$/u.test(version)) {
  console.error('Usage: node scripts/upgrade-dsh.mjs <prerelease-version>')
  process.exit(2)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const packages = Object.keys(manifest.devDependencies ?? {}).filter(name => name.startsWith('@deepseek-ai/dsh-'))
if (packages.length === 0) throw new Error('No DSH development dependencies found')

console.log(`[upgrade] setting ${packages.length} DSH development dependencies to ${version}`)
const result = spawnSync('pnpm', ['add', '--save-dev', '--save-exact', ...packages.map(name => `${name}@${version}`)], {
  cwd: root,
  stdio: 'inherit',
})
if (result.error) throw result.error
process.exit(result.status ?? 1)
