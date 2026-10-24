/** Standard DSH Git plugin: portable service plus optional Connection RPC adapter. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-settings'
import {
  CommitMessageUnavailableError,
  LlmCommitMessageProvider,
  UnavailableCommitMessageProvider,
  type CommitMessageProvider,
  type CommitMessageSelection,
} from './commit-message.ts'
import {
  GIT_COMMIT_MESSAGE_SETTINGS_NAMESPACE,
  GIT_COMMIT_MESSAGE_SETTINGS_SCHEMA,
  validateCommitMessageSettings,
  type CommitMessageSettings,
} from './commit-message-settings.ts'
import { markVolatile, readVolatile } from './compat/dsh-schema.ts'
import { GitRemoteUnavailableError, remoteCapability } from './remote/feature.ts'
import { asCredentialService } from './remote/credentials.ts'
import { GitRemoteRuntime } from './remote/runtime.ts'
import { GitRemoteError } from './remote/errors.ts'
import type { RemoteSettings } from './remote/settings.ts'
import {
  assertSessionRepository,
  bindSessionDirectory,
  enterWorktreeDirectory,
  isRepositoryWrite,
  sessionDirectoryAvailable,
  type SessionDirectory,
} from './session-directory.ts'
import { GitService } from './service.ts'
import type { GitCommitMessageCapability, GitFileChange, GitWorktreeCapability } from './types.ts'
import { createSessionWorktree, isUpstreamWorktrees, isWorktreePoolFs, worktreeMode } from './worktree-feature.ts'
import {
  GIT_WORKTREE_SETTINGS_NAMESPACE,
  GIT_WORKTREE_SETTINGS_SCHEMA,
  resolveWorktreeDirectory,
  validateWorktreeSettings,
  type WorktreeSettings,
} from './worktree-settings.ts'

export { CommitMessageUnavailableError, LlmCommitMessageProvider, UnavailableCommitMessageProvider } from './commit-message.ts'
export type { CommitMessageInput, CommitMessageProvider, CommitMessageSelection, LlmCommitMessageOptions } from './commit-message.ts'
export { GIT_COMMIT_MESSAGE_SETTINGS_NAMESPACE, GIT_COMMIT_MESSAGE_SETTINGS_SCHEMA, validateCommitMessageSettings } from './commit-message-settings.ts'
export type { CommitMessageSettings } from './commit-message-settings.ts'
export { GitRemoteUnavailableError, remoteCapability } from './remote/feature.ts'
export { GitCommandError, GitService, gitService } from './service.ts'
export type { GitCreateWorktreeRequest, WorktreePoolFs } from './service.ts'
export { parseGitLog, parseDecorations } from './log.ts'
export { parseBranches, parsePorcelainV2 } from './status.ts'
export { createSessionWorktree, isUpstreamWorktrees, worktreeMode } from './worktree-feature.ts'
export {
  DEFAULT_WORKTREE_DIRECTORY,
  GIT_WORKTREE_SETTINGS_NAMESPACE,
  GIT_WORKTREE_SETTINGS_SCHEMA,
  isPoolDirectory,
  resolveWorktreeDirectory,
  validateWorktreeSettings,
} from './worktree-settings.ts'
export type { UpstreamWorktrees } from './worktree-feature.ts'
export type { WorktreeSettings } from './worktree-settings.ts'
export type * from './types.ts'

export const name = 'dsh-plugin-git'
export const inject = ['subprocess']

/** Deployment-varying Git process policy. */
export interface Config {
  /** Git executable name or absolute path resolved by `ctx.subprocess`. */
  executable?: string
  /** Maximum bytes retained independently for stdout and stderr. */
  maxOutputBytes?: number
  /** Grace period used when managed subprocess termination is requested. */
  graceMs?: number
  /** Optional commit message generation backend. */
  commitMessage?: CommitMessageSettings
  /** Optional Worktrees feature: force-enable without the upstream runtime, and the local checkout pool. */
  worktrees?: WorktreeSettings
  /** Optional remote-platform settings; `refreshStoreExclusive` attests the store's cross-process modifyRecord exclusion. */
  remote?: RemoteSettings
}

export const Config = z.object({
  executable: z.string().default('git'),
  maxOutputBytes: z.natural().min(1024).default(8 * 1024 * 1024),
  graceMs: z.natural().min(1).default(3000),
  commitMessage: z.object({
    mode: markVolatile(z.union([z.const('inherit'), z.const('custom')])),
    provider: markVolatile(z.string()),
    model: markVolatile(z.string()),
    systemPrompt: markVolatile(z.string()),
    maxDiffBytes: markVolatile(z.natural().min(1024)),
  }),
  worktrees: z.object({
    enabled: markVolatile(z.boolean()),
    directory: markVolatile(z.string()),
  }),
  remote: z.object({
    clientId: markVolatile(z.string()),
    requestTimeoutMs: markVolatile(z.natural().min(1)),
    probeTimeoutMs: markVolatile(z.natural().min(1).max(5000)),
    refreshTtlMs: markVolatile(z.natural().min(1)),
    refreshPollMs: markVolatile(z.natural().min(1)),
    refreshStoreExclusive: markVolatile(z.boolean()),
    maxResponseBytes: markVolatile(z.natural().min(1024)),
  }),
})

/** Install the portable service and the transport adapter when Connection is present. */
export function apply(ctx: Context, config: Config): void {
  const service = new GitService(ctx.subprocess, {
    executable: config.executable ?? 'git',
    maxOutputBytes: config.maxOutputBytes ?? 8 * 1024 * 1024,
    graceMs: config.graceMs ?? 3000,
  })
  ctx.provide('git', service)
  const generation = assembleGeneration(ctx, config.commitMessage)
  const worktree = assembleWorktreeRuntime(ctx, config.worktrees)
  const remote: RemoteRuntime = { credentials: () => optionalService(ctx, 'credentials') }
  injectOptional(ctx, ['credentials'], bound => {
    const credentials = asCredentialService(optionalService(bound, 'credentials'))
    if (credentials === undefined) return
    const runtime = new GitRemoteRuntime(credentials, ctx.subprocess, service, config.remote)
    remote.current = runtime
    bound.on('credentials/record-updated', () => runtime.invalidate())
    bound.on('credentials/reference-updated', () => runtime.invalidate())
    return async () => { if (remote.current === runtime) remote.current = undefined; await runtime.dispose() }
  })
  let directory: SessionDirectory | undefined
  // Optional on hosts that predate working-directory. The fiber stays pending
  // until both services exist, and unload clears the binder without touching Git.
  injectOptional(ctx, ['agents', 'workingDirectory'], (bound) => {
    const services = bound as unknown as Record<string, unknown>
    const boundDirectory = bindSessionDirectory(services['agents'], services['workingDirectory'])
    if (boundDirectory === undefined) return
    directory = boundDirectory
    return () => { if (directory === boundDirectory) directory = undefined }
  })
  // Soft: a profile without a web server (headless, sdk) has no browser to
  // serve, and the service is unaffected.
  //
  // `webServer` MUST be in the dependency list so this callback only runs once
  // the route table exists, and the service MUST be read off `ctx.root`:
  // `connection.rpc.handle` resolves `webServer` as a property of the context
  // the service was READ from, and cordis property resolution from a plugin
  // fiber can only see that fiber's own injected services — a sibling row's
  // `webServer` is invisible, the registration dies with `cannot get property
  // "webServer" without inject`, and every client request then falls through
  // to the static SPA fallback as HTTP 405. Reading at the root (what the
  // upstream connection tests do) resolves against the shared service store.
  ctx.inject(['connection', 'webServer'], (connectionCtx) => {
    const connection = connectionCtx.root.get('connection')
    if (connection === undefined) {
      ctx.logger?.warn('dsh-plugin-git: connection resolved without the service; the RPC adapter is not mounted')
      return
    }
    return connection.rpc.handle('/git', async (endpoint, payload, signal) => {
      try {
        return { ok: true, value: await invoke(service, generation, worktree, directory, remote, endpoint, payload, signal) }
      } catch (error) {
        return {
          ok: false,
          error: {
            code:
              (error instanceof GitRemoteUnavailableError || error instanceof GitRemoteError)
                ? error.code
                : error instanceof CommitMessageUnavailableError
                  ? 'git/generation-unavailable'
                  : 'git/internal',
            message: endpoint.startsWith('remote-') && !(error instanceof GitRemoteUnavailableError || error instanceof GitRemoteError) ? 'git-remote: operation failed' : error instanceof Error ? error.message : String(error),
            details: error instanceof GitRemoteUnavailableError || error instanceof GitRemoteError ? error.details ?? {} : {},
          },
        }
      }
    })
  })
}

/** Mutable generation assembly; fibers swap the provider as services attach and detach. */
class GenerationAssembly {
  constructor(public provider: CommitMessageProvider = new UnavailableCommitMessageProvider('llm-unavailable')) {}
}

/**
 * Assemble commit message generation. Without configuration the plugin
 * inherits the host's default (session) model; a named provider/model — from
 * the settings section, else the composition entry — overrides the host
 * default. Generation never mutates the repository.
 * @param ctx - Plugin context whose fibers track service availability.
 * @param config - Composition entry for the settings section.
 * @returns The mutable assembly consumed by the RPC adapter.
 */
function assembleGeneration(ctx: Context, config: CommitMessageSettings | undefined): GenerationAssembly {
  const generation = new GenerationAssembly()
  const entry: CommitMessageSettings = config ?? {}
  let readSettings: (() => CommitMessageSettings) | undefined
  let readHostDefault: (() => CommitMessageSelection) | undefined
  const resolved = (): CommitMessageSettings => plainCommitMessageSettings(readSettings?.() ?? entry)
  if (resolved().mode === 'custom') validateCommitMessageSettings(resolved())
  const resolveSelection = (): CommitMessageSelection | undefined => {
    const source = resolved()
    if (source.mode !== 'inherit' && source.provider !== undefined && source.model !== undefined) {
      return { provider: source.provider, model: source.model }
    }
    return readHostDefault?.()
  }
  const resolveSystemPrompt = (): string | undefined => {
    const prompt = resolved().systemPrompt
    return prompt !== undefined && prompt.trim() !== '' ? prompt : undefined
  }
  const resolveMaxDiffBytes = (): number | undefined => resolved().maxDiffBytes
  ctx.inject(['llm'], (llmCtx) => {
    const llm = llmCtx.llm
    generation.provider = new LlmCommitMessageProvider(llm, {
      resolveSelection,
      resolveSystemPrompt,
      resolveMaxDiffBytes,
    })
    return () => { generation.provider = new UnavailableCommitMessageProvider('llm-unavailable') }
  })
  ctx.inject(['agentDefaultModel'], (modelCtx) => {
    const defaultModel = modelCtx.agentDefaultModel
    readHostDefault = () => {
      const selection = defaultModel.currentSelection()
      return { provider: selection.provider, model: selection.model }
    }
    return () => { readHostDefault = undefined }
  })
  // Plugin configuration edits this section live; without a settings provider
  // the composition entry above is the only source.
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.settings as unknown as {
      installSection?: (
        owner: Context,
        namespace: string,
        schema: typeof GIT_COMMIT_MESSAGE_SETTINGS_SCHEMA,
        initialValue: CommitMessageSettings,
        hooks: { setSource: (current: () => CommitMessageSettings) => void; onChange: () => void; validate: typeof validateCommitMessageSettings },
      ) => void
      configure?: (presentation: { auto?: boolean }, owner?: unknown) => () => void
    }
    if (settings.installSection !== undefined) {
      settings.installSection(ctx, GIT_COMMIT_MESSAGE_SETTINGS_NAMESPACE, GIT_COMMIT_MESSAGE_SETTINGS_SCHEMA, entry, {
        setSource: (current) => { readSettings = current },
        onChange: () => {},
        validate: validateCommitMessageSettings,
      })
    } else if (settings.configure !== undefined) {
      // DSH 0.1.7 derives edit forms from this plugin's volatile Config fields.
      // Our Client page owns the UI, while the plugin keeps reading the live Config.
      return settingsCtx.effect(() => settings.configure!({ auto: false }, settingsCtx.fiber), 'git: custom config page')
    }
    return () => { readSettings = undefined }
  })
  return generation
}

/**
 * Copy commit-message settings into plain values.
 * On DSH 0.1.7 each field is a volatile reference and must be snapshotted per
 * read so a settings edit applies to the next generation. Older hosts and the
 * legacy settings section already store plain values.
 * @param source - Composition entry, or the live settings section.
 * @returns Settings safe to treat as strings and numbers.
 */
function plainCommitMessageSettings(source: CommitMessageSettings | undefined): CommitMessageSettings {
  const mode = readVolatile(source?.mode)
  const provider = readVolatile(source?.provider)
  const model = readVolatile(source?.model)
  const systemPrompt = readVolatile(source?.systemPrompt)
  const maxDiffBytes = readVolatile(source?.maxDiffBytes)
  return {
    ...(mode === 'inherit' || mode === 'custom' ? { mode } : {}),
    ...(typeof provider === 'string' ? { provider } : {}),
    ...(typeof model === 'string' ? { model } : {}),
    ...(typeof systemPrompt === 'string' ? { systemPrompt } : {}),
    ...(typeof maxDiffBytes === 'number' ? { maxDiffBytes } : {}),
  }
}

/**
 * Live seams the Worktrees feature consults per request: resolved settings, the
 * upstream runtime, and the filesystem slice for the local-mode pool marker.
 * All three are read lazily so provider mount/unmount takes effect without a
 * Host restart.
 */
interface WorktreeRuntime {
  /** Resolved settings at call time (settings section, then composition entry). */
  settings: () => WorktreeSettings
  /** Upstream `ctx.worktrees`, when a mounted provider offers `create`. */
  upstream: () => import('./worktree-feature.ts').UpstreamWorktrees | undefined
  /** `ctx.fs` narrowed to the pool-marker methods, when mounted. */
  fs: () => import('./service.ts').WorktreePoolFs | undefined
}

/**
 * Wire the Worktrees feature: resolve settings from the live section or the
 * composition entry, register the settings section when a settings service
 * supports it, and expose lazy upstream/fs probes for the RPC dispatcher.
 * @param ctx - Plugin context.
 * @param entry - `Config.worktrees` composition entry.
 * @returns Runtime seams consumed by `invoke`.
 */
function assembleWorktreeRuntime(ctx: Context, entry: WorktreeSettings | undefined): WorktreeRuntime {
  let readSettings: (() => WorktreeSettings) | undefined
  const resolved = (): WorktreeSettings => plainWorktreeSettings(readSettings?.() ?? entry)
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.settings as unknown as {
      installSection?: (
        owner: Context,
        namespace: string,
        schema: typeof GIT_WORKTREE_SETTINGS_SCHEMA,
        initialValue: WorktreeSettings,
        hooks: { setSource: (current: () => WorktreeSettings) => void; onChange: () => void; validate: typeof validateWorktreeSettings },
      ) => void
    }
    if (settings.installSection === undefined) return
    settings.installSection(ctx, GIT_WORKTREE_SETTINGS_NAMESPACE, GIT_WORKTREE_SETTINGS_SCHEMA, entry ?? {}, {
      setSource: (current) => { readSettings = current },
      onChange: () => {},
      validate: validateWorktreeSettings,
    })
    return () => { readSettings = undefined }
  })
  validateWorktreeSettings(resolved())
  return {
    settings: resolved,
    upstream: () => {
      const service = optionalService(ctx, 'worktrees')
      return isUpstreamWorktrees(service) ? service : undefined
    },
    fs: () => {
      const service = optionalService(ctx, 'fs')
      return isWorktreePoolFs(service) ? service : undefined
    },
  }
}

/**
 * Copy worktree settings into plain values.
 * On DSH 0.1.7 each field is a volatile reference and must be snapshotted per
 * read so a settings edit applies to the next creation. Older hosts and the
 * legacy settings section already store plain values.
 * @param source - Composition entry, or the live settings section.
 * @returns Settings safe to treat as booleans and strings.
 */
function plainWorktreeSettings(source: WorktreeSettings | undefined): WorktreeSettings {
  const enabled = readVolatile(source?.enabled)
  const directory = readVolatile(source?.directory)
  return {
    ...(typeof enabled === 'boolean' ? { enabled } : {}),
    ...(typeof directory === 'string' ? { directory } : {}),
  }
}

interface RemoteRuntime {
  current?: GitRemoteRuntime | undefined
  credentials: () => unknown
}

/** Current capability answer for the generation backend, including why it is unavailable. */
function capability(generation: GenerationAssembly): GitCommitMessageCapability {
  const provider = generation.provider
  if (provider instanceof LlmCommitMessageProvider) {
    return provider.isReady() ? { available: true } : { available: false, reason: 'default-model-missing' }
  }
  if (provider instanceof UnavailableCommitMessageProvider) {
    return { available: false, reason: provider.reason }
  }
  return { available: true }
}

async function invoke(
  service: GitService,
  generation: GenerationAssembly,
  worktree: WorktreeRuntime,
  directory: SessionDirectory | undefined,
  remote: RemoteRuntime,
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  if (endpoint === 'remote-capability') {
    const boundary = remoteCapability(remote.credentials())
    return boundary.state === 'off' && boundary.reason !== 'implementation-pending' ? boundary : remote.current?.capability() ?? boundary
  }
  if (endpoint.startsWith('remote-')) {
    const boundary = remoteCapability(remote.credentials())
    if (boundary.state === 'off' && boundary.reason !== 'implementation-pending') throw new GitRemoteUnavailableError(boundary)
    if (remote.current !== undefined) return remote.current.handle(endpoint, payload, signal, (request, inner) => assertSessionRepository(service, directory, request, inner))
    throw new GitRemoteUnavailableError(remoteCapability(remote.credentials()))
  }
  const request = record(payload)
  if (isRepositoryWrite(endpoint)) await assertSessionRepository(service, directory, request, signal)
  switch (endpoint) {
    case 'directory-capability': return { available: sessionDirectoryAvailable(directory, request) }
    case 'set-directory': return enterWorktreeDirectory(service, directory, request, signal)
    case 'discover': return service.discover(stringField(request, 'path'), signal)
    case 'status': return service.status(stringField(request, 'repository'), signal)
    case 'diff': return service.diff(
      stringField(request, 'repository'),
      booleanField(request, 'staged'),
      optionalStringField(request, 'path'),
      signal,
    )
    case 'stage': return service.stage(stringField(request, 'repository'), optionalChangeField(request, 'change'), signal)
    case 'unstage': return service.unstage(stringField(request, 'repository'), optionalChangeField(request, 'change'), signal)
    case 'discard': {
      const modeField = optionalStringField(request, 'mode')
      const mode = modeField === 'head' || modeField === 'untracked' ? modeField : 'worktree'
      return service.discard(stringField(request, 'repository'), optionalChangeField(request, 'change'), signal, mode)
    }
    case 'commit': return service.commit(
      stringField(request, 'repository'),
      stringField(request, 'message'),
      signal,
      optionalBooleanField(request, 'amend') === true,
    )
    case 'push': return service.push(stringField(request, 'repository'), signal)
    case 'sync': return service.sync(stringField(request, 'repository'), signal)
    case 'create-branch': return service.createBranch(stringField(request, 'repository'), stringField(request, 'branch'), signal)
    case 'switch-branch': return service.switchBranch(stringField(request, 'repository'), stringField(request, 'branch'), signal)
    case 'log': {
      const limitField = request['limit']
      const skipField = request['skip']
      const scopeField = request['scope']
      const scope = scopeField === 'all' || scopeField === 'first-parent' ? scopeField : 'auto'
      return service.log(
        stringField(request, 'repository'),
        typeof limitField === 'number' ? limitField : 100,
        typeof skipField === 'number' ? skipField : 0,
        scope,
        signal,
      )
    }
    case 'commit-message-capability': return capability(generation)
    case 'worktree-capability': {
      const settings = worktree.settings()
      const capability: GitWorktreeCapability = {
        mode: worktreeMode(worktree.upstream(), settings),
        directory: resolveWorktreeDirectory(settings),
      }
      return capability
    }
    case 'create-worktree': return createSessionWorktree({
      service,
      directory,
      upstream: worktree.upstream(),
      fs: worktree.fs(),
      settings: worktree.settings,
    }, request, signal)
    case 'generate-commit-message': {
      const provider = generation.provider
      if (provider instanceof UnavailableCommitMessageProvider) {
        throw new CommitMessageUnavailableError(provider.reason)
      }
      return provider.generate({
        repository: stringField(request, 'repository'),
        stagedDiff: stringField(request, 'stagedDiff'),
      })
    }
    default: throw new Error(`unknown Git endpoint ${JSON.stringify(endpoint)}`)
  }
}

/**
 * Schedule an optional inject without declaring those services on this plugin's Context type.
 * Hosts that never provide the names leave the callback pending.
 * @param ctx - Plugin context.
 * @param names - Service names that must all be present.
 * @param callback - Runs once, and may return a disposer.
 */
function injectOptional(ctx: Context, names: readonly string[], callback: (bound: Context) => void | (() => void | Promise<void>)): void {
  const inject = (ctx as unknown as {
    inject(services: readonly string[], apply: (bound: Context) => void | (() => void | Promise<void>)): unknown
  }).inject.bind(ctx)
  inject(names, callback)
}

/**
 * Read an undeclared host service by name.
 * Undeclared names do not type-check through `Context.get`, so this narrows the
 * accessor structurally; callers probe the result's shape themselves.
 * @param ctx - Plugin context.
 * @param name - Service name in the host service store.
 * @returns The mounted service value, or undefined.
 */
function optionalService(ctx: Context, name: string): unknown {
  const get = (ctx as unknown as { get?(name: string): unknown }).get
  return typeof get === 'function' ? get.call(ctx, name) : undefined
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Git request must be an object')
  return value as Record<string, unknown>
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== 'string' || field.length === 0) throw new Error(`Git request ${key} must be a non-empty string`)
  return field
}

function optionalStringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key]
  if (field === undefined) return undefined
  if (typeof field !== 'string' || field.length === 0) throw new Error(`Git request ${key} must be a non-empty string`)
  return field
}

/** Read one complete file-change operation from a Client request. */
function optionalChangeField(value: Record<string, unknown>, key: string): GitFileChange | undefined {
  const field = value[key]
  if (field === undefined) return undefined
  const change = record(field)
  const originalPath = optionalStringField(change, 'originalPath')
  return {
    path: stringField(change, 'path'),
    status: stringField(change, 'status'),
    ...(originalPath === undefined ? {} : { originalPath }),
  }
}

function booleanField(value: Record<string, unknown>, key: string): boolean {
  const field = value[key]
  if (typeof field !== 'boolean') throw new Error(`Git request ${key} must be a boolean`)
  return field
}

function optionalBooleanField(value: Record<string, unknown>, key: string): boolean | undefined {
  const field = value[key]
  if (field === undefined) return undefined
  if (typeof field !== 'boolean') throw new Error(`Git request ${key} must be a boolean`)
  return field
}
