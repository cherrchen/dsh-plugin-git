// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import {
  GIT_CHANGES_ID,
  GIT_CHANGES_KIND,
  GIT_DIFF_ID,
  GIT_DIFF_KIND,
  GIT_GRAPH_ID,
  GIT_GRAPH_KIND,
  GIT_WORKTREES_ID,
  GIT_WORKTREES_KIND,
  gitDiffAddress,
} from '../src/client/contract.ts'
import type { GitDesktopCapability } from '../src/client/controller.ts'
import type { GitSessionControllers } from '../src/client/session-controllers.ts'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

const minimalSidebar = () => ({
  sidebarRight: {
    openTab: vi.fn(),
    openResource: vi.fn(),
    isExpanded: vi.fn(() => false),
  },
  sidebarRightTabs: {
    register: vi.fn((_definition: SidebarRightTabDefinition) => () => {}),
  },
})

describe('Git client lifecycle', () => {
  it('registers composer control and sidebar tab bodies', async () => {
    const ctx = new Context()
    const registrations: Array<{ name?: string; id?: string; key?: string }> = []
    const sidebar = minimalSidebar()
    ctx.provide('slots', {
      inject: (_name: string, callback: () => unknown) => ctx.effect(() => callback() as () => void),
      register: (entry: { name?: string; id?: string; key?: string }) => {
        registrations.push(entry)
        return () => { registrations.splice(registrations.indexOf(entry), 1) }
      },
    } as never)
    ctx.provide('connection', { rpc: { call: vi.fn() } } as never)
    ctx.provide('locale', {
      register: () => () => {},
      bind: () => (key: string) => key,
      subscribe: () => () => {},
    } as never)
    ctx.provide('sidebarRight', sidebar.sidebarRight as never)
    ctx.provide('sidebarRightTabs', sidebar.sidebarRightTabs as never)
    const fiber = ctx.plugin({ inject, apply })
    await fiber.await()
    expect(registrations.map(entry => entry.name)).toEqual([
      'conversation.input.left',
      'sidebar.right.pane.tab',
      'sidebar.right.pane.tab',
      'sidebar.right.pane.tab',
      'sidebar.right.pane.tab',
      'sidebar.right.pane.tab.title',
      'sidebar.right.pane.tab.title',
      'sidebar.right.pane.tab.title',
    ])
    expect(registrations.map(entry => entry.key ?? entry.id)).toEqual([
      'git-context',
      GIT_CHANGES_ID,
      GIT_DIFF_ID,
      GIT_GRAPH_ID,
      GIT_WORKTREES_ID,
      GIT_CHANGES_ID,
      GIT_GRAPH_ID,
      GIT_WORKTREES_ID,
    ])
    expect(sidebar.sidebarRightTabs.register).toHaveBeenCalledTimes(3)
    const changesDefinition = sidebar.sidebarRightTabs.register.mock.calls[0]![0]
    const diffDefinition = sidebar.sidebarRightTabs.register.mock.calls[1]![0]
    const graphDefinition = sidebar.sidebarRightTabs.register.mock.calls[2]![0]
    expect(changesDefinition.id).toBe(GIT_CHANGES_ID)
    expect(changesDefinition.kind).toBe(GIT_CHANGES_KIND)
    expect(changesDefinition.patterns).toBeUndefined()
    expect(diffDefinition.id).toBe(GIT_DIFF_ID)
    expect(diffDefinition.kind).toBe(GIT_DIFF_KIND)
    expect(diffDefinition.patterns).toEqual(['dsh-resource://git/diff/**'])
    expect(diffDefinition.canOpen?.(gitDiffAddress('a.ts', true))).toBe(true)
    expect(diffDefinition.canOpen?.('dsh-resource://git/other/a.ts/worktree')).toBe(false)
    expect(diffDefinition.title(gitDiffAddress('dir/a.ts', false))).toBe('a.ts')
    expect(graphDefinition.kind).toBe(GIT_GRAPH_KIND)

    // Guide entries replace the old launcher cards: changes then graph, in order.
    expect(changesDefinition.guide?.map(entry => entry.order)).toEqual([10])
    expect(graphDefinition.guide?.map(entry => entry.order)).toEqual([11])
    expect(diffDefinition.guide).toBeUndefined()

    const composer = registrations.find(entry => entry.id === 'git-context') as {
      inject?: () => { gitSessions: GitSessionControllers; openDetails: () => void }
    }

    const desktop: GitDesktopCapability = {
      shell: { showItemInFolder: vi.fn(), openPath: vi.fn(() => Promise.resolve('')) },
      notification: { show: vi.fn(() => Promise.resolve({ shown: true })) },
    }
    const provider = ctx.plugin((desktopCtx) => { desktopCtx.provide('desktop', desktop) })
    await provider.await()
    const sessionController = () => composer.inject?.().gitSessions.controllerFor('lifecycle-session')
    expect(sessionController()?.getSnapshot().desktopAvailable).toBe(true)
    await provider.dispose()
    expect(sessionController()?.getSnapshot().desktopAvailable).toBe(false)

    const openDetails = composer.inject?.().openDetails
    expect(openDetails).toBeTypeOf('function')
    sidebar.sidebarRight.openTab.mockImplementationOnce(() => {
      throw new Error('sidebar open failed')
    })
    expect(() => { openDetails?.() }).toThrow(/sidebar open failed/)
    expect(sidebar.sidebarRight.openTab).toHaveBeenCalledWith(GIT_CHANGES_KIND)

    // Diff navigation goes through the resource face with the exact address.
    sessionController()?.openDiff('a.ts', true)
    expect(sidebar.sidebarRight.openResource).toHaveBeenCalledWith(
      gitDiffAddress('a.ts', true),
      { params: { path: 'a.ts', staged: true } },
    )
    expect(registrations.some(entry => entry.name === 'shell.overlay')).toBe(false)
    expect(registrations.some(entry => entry.name === 'settings.plugin.item')).toBe(false)
    expect(registrations.some(entry => entry.name === 'plugins.bundle.config')).toBe(false)
    expect(registrations.some(entry => entry.name === 'settings.plugins.tab')).toBe(false)

    await fiber.dispose()
  })

  it('registers the commit-message card when settingsScope is present', async () => {
    const ctx = new Context()
    const registrations: Array<{ name?: string; key?: string; id?: string; label?: string | (() => string) }> = []
    const sidebar = minimalSidebar()
    ctx.provide('slots', {
      inject: (_name: string, callback: () => unknown) => ctx.effect(() => callback() as () => void),
      register: (entry: { name?: string; key?: string; id?: string; label?: string | (() => string) }) => {
        registrations.push(entry)
        return () => { registrations.splice(registrations.indexOf(entry), 1) }
      },
    } as never)
    ctx.provide('connection', { rpc: { call: vi.fn() } } as never)
    ctx.provide('locale', {
      register: () => () => {},
      bind: () => (key: string) => key,
      subscribe: () => () => {},
    } as never)
    ctx.provide('sidebarRight', sidebar.sidebarRight as never)
    ctx.provide('sidebarRightTabs', sidebar.sidebarRightTabs as never)
    ctx.provide('settingsScope', {
      bind: () => ({
        getSnapshot: () => ({
          status: 'unavailable',
          value: undefined,
          base: undefined,
          user: undefined,
          revision: undefined,
          writable: false,
          mode: 'host',
        }),
        subscribe: () => () => {},
        mutate: vi.fn(async () => {}),
        set: vi.fn(async () => {}),
        unset: vi.fn(async () => {}),
      }),
    } as never)
    const fiber = ctx.plugin({ inject, apply })
    await fiber.await()
    expect(registrations.filter(entry => entry.name === 'settings.plugin.item').map(entry => entry.key))
      .toEqual(['git-commit-message', 'git-worktrees'])
    expect(registrations.filter(entry => entry.name === 'plugins.bundle.config').map(entry => entry.key))
      .toEqual(['@dsh-electron/dsh-plugin-git'])
    expect(registrations.some(entry => entry.name === 'settings.plugins.tab')).toBe(false)
    await fiber.dispose()
    expect(registrations.some(entry => entry.name === 'settings.plugin.item')).toBe(false)
    expect(registrations.some(entry => entry.name === 'plugins.bundle.config')).toBe(false)
  })

  it('reads the config form by the patch row id', async () => {
    const ctx = new Context()
    const get = vi.fn(() => ({
      getSnapshot: () => ({
        status: 'unavailable',
        value: undefined,
        base: undefined,
        user: undefined,
        revision: undefined,
        writable: false,
      }),
      subscribe: () => () => {},
      mutate: vi.fn(async () => {}),
    }))
    const sidebar = minimalSidebar()
    ctx.provide('slots', {
      inject: (_name: string, callback: () => unknown) => ctx.effect(() => callback() as () => void),
      register: () => () => {},
    } as never)
    ctx.provide('connection', { rpc: { call: vi.fn() } } as never)
    ctx.provide('locale', {
      register: () => () => {},
      bind: () => (key: string) => key,
      subscribe: () => () => {},
    } as never)
    ctx.provide('sidebarRight', sidebar.sidebarRight as never)
    ctx.provide('sidebarRightTabs', sidebar.sidebarRightTabs as never)
    ctx.provide('configForms', { get } as never)
    const fiber = ctx.plugin({ inject, apply })
    await fiber.await()
    expect(get).toHaveBeenCalledWith('dsh-plugin-git')
    await fiber.dispose()
  })

  it('registers the worktrees tab type once the host reports a mode and disposes it on unload', async () => {
    const ctx = new Context()
    const sidebar = minimalSidebar()
    const tabDisposers: Array<ReturnType<typeof vi.fn>> = []
    sidebar.sidebarRightTabs.register.mockImplementation(() => {
      const dispose = vi.fn()
      tabDisposers.push(dispose)
      return dispose
    })
    ctx.provide('slots', {
      inject: (_name: string, callback: () => unknown) => ctx.effect(() => callback() as () => void),
      register: () => () => {},
    } as never)
    ctx.provide('connection', {
      rpc: {
        call: vi.fn(async (_channel: string, endpoint: string) =>
          endpoint === 'worktree-capability'
            ? { ok: true as const, value: { mode: 'local', directory: '.agents/worktrees' } }
            : { ok: true as const, value: null }),
      },
    } as never)
    ctx.provide('locale', {
      register: () => () => {},
      bind: () => (key: string) => key,
      subscribe: () => () => {},
    } as never)
    ctx.provide('sidebarRight', sidebar.sidebarRight as never)
    ctx.provide('sidebarRightTabs', sidebar.sidebarRightTabs as never)
    const fiber = ctx.plugin({ inject, apply })
    await fiber.await()
    await vi.waitFor(() => expect(sidebar.sidebarRightTabs.register).toHaveBeenCalledTimes(4))
    const worktreeDefinition = sidebar.sidebarRightTabs.register.mock.calls[3]![0]
    expect(worktreeDefinition.id).toBe(GIT_WORKTREES_ID)
    expect(worktreeDefinition.kind).toBe(GIT_WORKTREES_KIND)
    await fiber.dispose()
    expect(tabDisposers).toHaveLength(4)
    for (const dispose of tabDisposers) expect(dispose).toHaveBeenCalled()
  })

  it('adds and removes only the worktrees enhancement when the host provider changes while idle', async () => {
    vi.useFakeTimers()
    const ctx = new Context()
    const sidebar = minimalSidebar()
    let mode = 'off'
    const tabDisposers: Array<ReturnType<typeof vi.fn>> = []
    sidebar.sidebarRightTabs.register.mockImplementation(() => {
      const dispose = vi.fn()
      tabDisposers.push(dispose)
      return dispose
    })
    const registrations: Array<{ name?: string }> = []
    ctx.provide('slots', {
      inject: (_name: string, callback: () => unknown) => ctx.effect(() => callback() as () => void),
      register: (entry: { name?: string }) => {
        registrations.push(entry)
        return () => { registrations.splice(registrations.indexOf(entry), 1) }
      },
    } as never)
    const call = vi.fn(async () => ({ ok: true as const, value: { mode, directory: '' } }))
    ctx.provide('connection', { rpc: { call } } as never)
    ctx.provide('locale', {
      register: () => () => {},
      bind: () => (key: string) => key,
      subscribe: () => () => {},
    } as never)
    ctx.provide('sidebarRight', sidebar.sidebarRight as never)
    ctx.provide('sidebarRightTabs', sidebar.sidebarRightTabs as never)
    const fiber = ctx.plugin({ inject, apply })
    try {
      await fiber.await()
      await vi.advanceTimersByTimeAsync(0)
      expect(sidebar.sidebarRightTabs.register).toHaveBeenCalledTimes(3)
      const coreSlots = [...registrations]
      mode = 'upstream'
      await vi.advanceTimersByTimeAsync(5_000)
      expect(sidebar.sidebarRightTabs.register).toHaveBeenCalledTimes(4)
      expect(sidebar.sidebarRightTabs.register.mock.calls[3]![0].kind).toBe(GIT_WORKTREES_KIND)
      mode = 'off'
      await vi.advanceTimersByTimeAsync(5_000)
      expect(tabDisposers[3]).toHaveBeenCalledTimes(1)
      for (const dispose of tabDisposers.slice(0, 3)) expect(dispose).not.toHaveBeenCalled()
      expect(registrations).toEqual(coreSlots)
      mode = 'upstream'
      await vi.advanceTimersByTimeAsync(5_000)
      expect(sidebar.sidebarRightTabs.register).toHaveBeenCalledTimes(5)
      await fiber.dispose()
      const calls = call.mock.calls.length
      await vi.advanceTimersByTimeAsync(10_000)
      expect(call).toHaveBeenCalledTimes(calls)
      expect(registrations.filter(entry => entry.name?.startsWith('sidebar.'))).toEqual([])
      for (const dispose of tabDisposers) expect(dispose).toHaveBeenCalledTimes(1)
    } finally {
      await fiber.dispose()
      vi.useRealTimers()
    }
  })

  it('loads the model catalog through remote.session.modelCatalog', async () => {
    const ctx = new Context()
    const registrations: Array<{ name?: string; inject?: () => { controller: { setMode: (mode: 'inherit' | 'custom') => void; getSnapshot: () => { catalogStatus: string } } } }> = []
    const sidebar = minimalSidebar()
    ctx.provide('slots', {
      inject: (_name: string, callback: () => unknown) => ctx.effect(() => callback() as () => void),
      register: (entry: { name?: string; inject?: () => { controller: { setMode: (mode: 'inherit' | 'custom') => void; getSnapshot: () => { catalogStatus: string } } } }) => {
        registrations.push(entry)
        return () => { registrations.splice(registrations.indexOf(entry), 1) }
      },
    } as never)
    ctx.provide('connection', { rpc: { call: vi.fn() } } as never)
    ctx.provide('locale', {
      register: () => () => {},
      bind: () => (key: string) => key,
      subscribe: () => () => {},
    } as never)
    ctx.provide('sidebarRight', sidebar.sidebarRight as never)
    ctx.provide('sidebarRightTabs', sidebar.sidebarRightTabs as never)
    ctx.provide('settingsScope', {
      bind: () => ({
        getSnapshot: () => ({
          status: 'ready',
          value: {},
          base: {},
          user: {},
          revision: 0,
          writable: true,
          mode: 'host',
        }),
        subscribe: () => () => {},
        mutate: vi.fn(async () => {}),
        set: vi.fn(async () => {}),
        unset: vi.fn(async () => {}),
      }),
    } as never)
    const session = {
      token: 'bound',
      modelCatalog() {
        expect(this.token).toBe('bound')
        return Promise.resolve({
          ok: true as const,
          value: {
            groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'chat', name: 'Chat' }] }],
            failures: [],
          },
        })
      },
    }
    ctx.provide('remote.session', session)
    const fiber = ctx.plugin({ inject, apply })
    await fiber.await()
    const card = registrations.find(entry => entry.name === 'settings.plugin.item')
    card?.inject?.().controller.setMode('custom')
    await vi.waitFor(() => {
      expect(card?.inject?.().controller.getSnapshot().catalogStatus).toBe('ready')
    })
    await fiber.dispose()
  })
})
