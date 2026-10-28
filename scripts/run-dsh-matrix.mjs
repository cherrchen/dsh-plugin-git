/** Isolated supported/candidate DSH matrix using the canonical upgrade workflow. */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = process.argv.slice(2)
const mode = args[0], output = args[1], only = args[2]
const candidate = args[3] === '--candidate'
if (!['--offline', '--online-install'].includes(mode) || output === undefined || !isAbsolute(output) || (only !== undefined && !/^\d+\.\d+\.\d+-(?:alpha|beta|rc)\.\d+$/u.test(only)) || args.length > 4 || (args[3] !== undefined && !candidate) || (candidate && only === undefined)) {
  console.error('Usage: node scripts/run-dsh-matrix.mjs <--offline|--online-install> <new-absolute-output-directory> [exact-version [--candidate]]')
  process.exit(2)
}
const out = resolve(output), inside = relative(root, out)
if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside)) || existsSync(out)) throw Error('Output must be a new directory outside the working tree')
const versionSource = readFileSync(join(root, 'src/compat/dsh-version.ts'), 'utf8')
const match = /export const SUPPORTED_DSH_RELEASES = \[([^\]]*)\]/u.exec(versionSource)
if (match === null) throw Error('Canonical DSH release list is missing')
const releases = [...match[1].matchAll(/'([^']+)'/gu)].map(item => item[1])
if (only !== undefined && !releases.includes(only) && !candidate) throw Error('Requested version is not in the canonical release list; use --candidate to validate without promoting')
const dev = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).devDependencies['@deepseek-ai/dsh-settings']
if (!releases.includes(dev)) throw Error('Development pin is not a supported release')
mkdirSync(out, { recursive: true })
const store = join(out, 'store'), sourceStore = join(root, '.pnpm-store', 'v11')
if (existsSync(sourceStore)) { mkdirSync(store); cpSync(sourceStore, join(store, 'v11'), { recursive: true }) }
const env = Object.fromEntries(['PATH', 'TMPDIR', 'SHELL', 'LANG', 'LC_ALL', 'SystemRoot', 'WINDIR'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]))
const packageManager = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).packageManager
const pnpmVersion = typeof packageManager === 'string' && packageManager.startsWith('pnpm@') ? packageManager.slice(5) : ''
const corepackSource = process.env.COREPACK_HOME ?? join(homedir(), '.cache', 'node', 'corepack')
const cachedPnpm = join(corepackSource, 'v1', 'pnpm', pnpmVersion), isolatedCorepack = join(out, 'corepack')
if (pnpmVersion !== '' && existsSync(cachedPnpm)) { mkdirSync(join(isolatedCorepack, 'v1', 'pnpm'), { recursive: true }); cpSync(cachedPnpm, join(isolatedCorepack, 'v1', 'pnpm', pnpmVersion), { recursive: true }) }
const userConfig = join(out, 'user.npmrc'), globalConfig = join(out, 'global.npmrc')
writeFileSync(userConfig, ''); writeFileSync(globalConfig, '')
Object.assign(env, { npm_config_cache: join(out, 'npm-cache'), npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig, npm_config_registry: 'https://registry.npmjs.org/', XDG_CACHE_HOME: join(out, 'cache'), COREPACK_HOME: isolatedCorepack, pnpm_config_minimum_release_age: '0', NO_COLOR: '1' })
// Install hooks inherit this guard too: offline means no Node HTTP/socket fallback.
const networkGuard = join(out, 'offline-network-guard.cjs')
writeFileSync(networkGuard, "const denied = () => { throw new Error('offline matrix: network disabled') }; for (const name of ['node:net', 'node:tls']) { const module = require(name); module.connect = denied; module.createConnection = denied } for (const name of ['node:http', 'node:https']) { const module = require(name); module.request = denied; module.get = denied } globalThis.fetch = denied;\n")
const roots = ['src', 'docs', 'scripts', 'tests', '.agent', '.github']
const files = ['AGENTS.md', 'README.md', 'README.zh.md', 'README.i18n.yaml', 'CHANGELOG.md', 'CHANGELOG.zh.md', 'CHANGELOG.i18n.yaml', 'CONTRIBUTING.md', 'CONTRIBUTING.zh.md', 'CONTRIBUTING.i18n.yaml', 'LICENSE', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.pnpmfile.cjs', 'cordis.patch.yml', 'playwright.config.ts', 'tsconfig.json', 'tsconfig.client.json', 'tsconfig.host.json', 'tsconfig.standalone.client.json', 'tsconfig.standalone.host.json', 'tsdown.config.ts', 'tsdown.standalone.config.ts', 'vitest.config.ts', 'vitest.artifact.config.ts']
const snapshot = join(out, 'source-snapshot'); mkdirSync(snapshot)
for (const entry of [...roots, ...files]) if (existsSync(join(root, entry))) cpSync(join(root, entry), join(snapshot, entry), { recursive: true, filter: path => !/(?:^|\/)(?:node_modules|\.git|\.pnpm-store|test-results|\.env(?:\..*)?)$/u.test(path) })
const all = only === undefined ? releases : [only]
const results = []
function command(cwd, name, executable, argv, version) {
  const laneEnvironment = version === undefined ? env : { ...env, DSH_COMPAT_VERSION: version, ...(candidate ? { DSH_COMPAT_MODE: 'warn' } : {}) }
  const childEnvironment = mode === '--offline' && executable === 'pnpm' && argv[0] === 'install' && !argv.includes('--lockfile-only') ? { ...laneEnvironment, npm_config_offline: 'true', NODE_OPTIONS: `--require=${JSON.stringify(networkGuard)}` } : laneEnvironment
  const result = spawnSync(executable, argv, { cwd, env: childEnvironment, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const outputText = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error === undefined ? '' : `\n${result.error.message}\n`}`
  writeFileSync(join(cwd, '..', `${name}.log`), outputText)
  return result.status ?? 1
}
for (const version of all) {
  const lane = join(out, version), work = join(lane, 'work'); mkdirSync(work, { recursive: true })
  cpSync(snapshot, work, { recursive: true })
  const record = { version, mode, candidate, gates: {} }; results.push(record)
  const installOptions = ['install', '--frozen-lockfile', '--store-dir', store, ...(mode === '--offline' ? ['--offline'] : [])]
  record.gates.bootstrap = command(work, 'bootstrap', 'pnpm', installOptions)
  if (record.gates.bootstrap === 0 && version !== dev) record.gates.upgrade = command(work, 'upgrade', 'node', ['scripts/upgrade-dsh.mjs', version], version)
  if (record.gates.upgrade === 0 && mode === '--online-install') {
    // Auto-installed root peers from the bootstrap lock can survive an upgrade
    // even when the new host requires another prerelease of include/group.
    rmSync(join(work, 'pnpm-lock.yaml'))
    rmSync(join(work, 'node_modules'), { recursive: true, force: true })
  }
  if (record.gates.bootstrap === 0 && version !== dev && record.gates.upgrade === 0 && mode === '--offline') record.gates.metadata = command(work, 'metadata', 'pnpm', ['install', '--lockfile-only', '--ignore-scripts', '--store-dir', store], version)
  if (record.gates.bootstrap === 0 && version !== dev && record.gates.upgrade === 0 && (mode !== '--offline' || record.gates.metadata === 0)) record.gates.install = command(work, 'install', 'pnpm', ['install', mode === '--offline' ? '--frozen-lockfile' : '--no-frozen-lockfile', '--store-dir', store, ...(mode === '--offline' ? ['--offline'] : [])], version)
  if (record.gates.bootstrap === 0 && (version === dev || record.gates.install === 0)) {
    for (const [name, argv] of [['peers', ['peers', 'check']], ['compat', ['compat:check']], ['test', ['test']], ['docs', ['docs:check']], ['build', ['build']], ['artifact', ['test:artifact']], ['pack', ['pack', '--pack-destination', lane]]]) record.gates[name] = command(work, name, 'pnpm', argv, version)
  }
  writeFileSync(join(out, 'results.json'), JSON.stringify({ developmentPin: dev, releases: all, results }, null, 2) + '\n')
  console.log(`[matrix] ${version}: ${JSON.stringify(record.gates)}`)
}
if (results.some(lane => ['bootstrap', 'peers', 'compat', 'test', 'docs', 'build', 'artifact', 'pack'].some(name => lane.gates[name] !== 0) || (lane.version !== dev && (lane.gates.upgrade !== 0 || lane.gates.install !== 0)))) process.exitCode = 1
