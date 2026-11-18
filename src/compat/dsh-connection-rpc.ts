import type { Context } from '@deepseek-ai/cordis'
import type { HostConnectionHandle, HostConnectionRpc } from '@deepseek-ai/dsh-client-connection'

/** Bind Connection's RPC getter to the fiber that injects the web server. */
export function connectionRpcFor(owner: Context, connection: HostConnectionHandle): HostConnectionRpc {
  for (let source: object | null = connection; source !== null; source = Object.getPrototypeOf(source)) {
    const rpc = Object.getOwnPropertyDescriptor(source, 'rpc')
    if (rpc === undefined) continue
    if (rpc.get === undefined) break

    // Newer Cordis traces getters through their definition site. Connection's
    // getter captures this.ctx, and the provider does not inject webServer.
    const receiver = new Proxy(connection, {
      get(target, key, proxy) {
        return key === 'ctx' ? owner : Reflect.get(target, key, proxy)
      },
    })
    return rpc.get.call(receiver) as HostConnectionRpc
  }
  return connection.rpc
}
