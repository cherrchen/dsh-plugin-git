import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const nodeRequire = createRequire(import.meta.url)

type Factory = (require: NodeRequire) => Record<string, unknown>

type ModuleLoaderWindow = typeof globalThis & {
  window?: ModuleLoaderWindow
  __ModuleLoader__?: {
    load(handoff: { id: string; factory: Factory }): void
  }
}

const factories = new Map<string, Factory>()
const materialized = new Map<string, Record<string, unknown>>()

function ensureWindow(): ModuleLoaderWindow {
  const root = globalThis as ModuleLoaderWindow
  if (root.window === undefined) root.window = root
  return root.window
}

function bundleRequire(specifier: string): unknown {
  if (materialized.has(specifier)) return materialized.get(specifier)
  return nodeRequire(specifier)
}

ensureWindow().__ModuleLoader__ = {
  load({ id, factory }: { id: string; factory: Factory }) {
    if (!materialized.has(id)) materialized.set(id, factory(bundleRequire as NodeRequire))
    factories.set(id, factory)
  },
}

/** Materialize one published client bundle through the DSH `__ModuleLoader__` protocol. */
export function materializeClientBundle(packageName: string): Record<string, unknown> {
  const cached = materialized.get(packageName)
  if (cached !== undefined) return cached
  const entry = nodeRequire.resolve(`${packageName}/client`)
  const source = readFileSync(entry, 'utf8')
  const evaluate = new Function('window', 'globalThis', `${source}\n;return null;`)
  evaluate(ensureWindow(), globalThis)
  const factory = factories.get(packageName)
  if (factory === undefined) throw new Error(`client bundle ${packageName} did not register via __ModuleLoader__.load`)
  const exports = factory(bundleRequire as NodeRequire)
  materialized.set(packageName, exports)
  return exports
}
