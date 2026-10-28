import { GitRemoteRuntime } from '../../../../src/remote/runtime.ts'
const settings = { instances: [{ url: 'https://git.example.com', clientId: 'fixture-app' }] }
const credentials = {
  readRecord: async () => undefined,
  modifyRecord: async () => undefined,
  deleteRecord: async () => {},
  resolve: async () => undefined,
  describe: async () => ({ configured: false, writable: true }),
  describeRecord: async () => ({ configured: false, writable: true }),
}
const subprocess = { spawn() { throw Error('unexpected subprocess') }, async resolveExecutable() { throw Error('unexpected subprocess') } }
const service = { async remoteCommand(_root, args) { return args[1] === 'get-url' ? 'https://git.example.com/group/repo.git\n' : 'origin\n' } }
const runtime = new GitRemoteRuntime(credentials, subprocess, service, settings)
const signal = new AbortController().signal
const within = (promise) => Promise.race([promise.then(() => 'resolved', () => 'rejected'), new Promise(resolve => setTimeout(() => resolve('pending-after-1500ms'), 1500))])
let checks = 0
const pending = runtime.handle('remote-pr', { remoteProtocol: 2, provider: 'gitlab', instance: 'https://git.example.com', repository: '/fixture', path: 'group/repo', number: 7 }, signal, async () => {
  if (++checks === 1) settings.instances = []
})
const operation = await within(pending)
const discovery = await within(runtime.handle('remote-repositories', { remoteProtocol: 2, repository: '/fixture' }, signal, async () => {}))
const legacyCapability = await within(runtime.capability())
const disposal = await within(runtime.dispose())
console.log(JSON.stringify({ scenario: 'remove-instance-at-first-business-session-guard', checks, operation, discovery, legacyCapability, disposal, externalNetwork: false }, null, 2))
if (operation.startsWith('pending') || discovery.startsWith('pending') || disposal.startsWith('pending')) process.exitCode = 1
