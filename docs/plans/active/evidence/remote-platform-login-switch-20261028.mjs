import { GitRemoteFeature } from '../../../../src/client/remote.ts'
const instances = ['https://first.example', 'https://second.example']
const targets = instances.map(instance => ({ provider: 'gitlab', instance, path: 'group/repo', scope: { provider: 'gitlab', instance } }))
const calls = []
const rpc = { async call(_channel, endpoint, payload, signal) {
  calls.push({ endpoint, instance: payload.instance, attemptId: payload.attemptId })
  if (endpoint === 'remote-repositories') return { ok: true, value: { remoteProtocol: 2, value: { state: 'supported', remotes: targets.map((identity, i) => ({ name: i ? 'upstream' : 'origin', identity })) } } }
  const scope = { provider: 'gitlab', instance: payload.instance }, generation = { instanceId: payload.instance, revision: 1 }
  const viewer = { host: new URL(payload.instance).hostname, userId: '9', login: 'fixture' }
  const actions = { canComment: false, canReview: false, canClose: false, canMerge: false, canCreatePr: false }
  const values = {
    'remote-capability': { state: 'on', generation, auth: { state: 'authenticated' }, viewer, actions, loginAvailable: true },
    'remote-repository': { actionScope: { path: 'group/repo', projectId: '42' }, viewer, actions },
    'remote-list-prs': { items: [], truncated: false },
    'remote-login': { attemptId: 'first-instance-attempt', userCode: 'ABCD', verificationUri: `${payload.instance}/oauth/device` },
  }
  if (endpoint === 'remote-poll-login') return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true }))
  if (endpoint === 'remote-cancel-login') return { ok: false, error: { code: 'git/remote-unavailable', details: { reason: 'unknown-attempt' } } }
  return { ok: true, value: { remoteProtocol: 2, scope, generation, value: values[endpoint] } }
} }
const feature = new GitRemoteFeature(rpc)
feature.scoped.observeCapability({ state: 'on', remoteProtocol: 2 })
const controller = feature.gitlabControllerFor('fixture-session')
controller.setRepository('/fixture')
for (let i = 0; i < 100 && (controller.getSnapshot().busy || !controller.getSnapshot().facts); i++) await new Promise(resolve => setTimeout(resolve, 1))
await controller.login()
const originalLogin = controller.getSnapshot().login
await controller.select(targets[1])
const afterSwitch = { target: controller.getSnapshot().target.scope.instance, login: controller.getSnapshot().login, busy: controller.getSnapshot().busy }
await controller.cancelLogin()
const cancellation = calls.filter(call => call.endpoint === 'remote-cancel-login')
feature.dispose()
console.log(JSON.stringify({ originalLogin, afterSwitch, cancellation, externalNetwork: false }, null, 2))
const wrongLink = afterSwitch.login !== undefined && !afterSwitch.login.verificationUri.startsWith(`${afterSwitch.target}/`)
const wrongCancellation = cancellation.some(call => call.attemptId === originalLogin?.attemptId && call.instance !== instances[0])
if (wrongLink || wrongCancellation) process.exitCode = 1
