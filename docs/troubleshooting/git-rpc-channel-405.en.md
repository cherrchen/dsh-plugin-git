[中文](git-rpc-channel-405.md) | English

# HTTP 405 on the `/git` RPC channel

## Symptoms

The client reports `transport failure for /git/discover: HTTP 405`. The branch selector beside the composer can disappear, and Git sidebar tabs can fail to load. Send unauthenticated `POST /api/discover` and `POST /git/discover` requests to the same Web host. If the first returns 401 and the second returns 405 with `Allow: GET, HEAD`, the static fallback received the request because the host had no registered `/git` channel.

## Cause

The DSH Connection `rpc` getter captures `this.ctx` as the channel owner. `rpc.handle` reads `webServer` in that context to register the route. Older versions let the plugin reach the shared service store by reading Connection from the root context. Starting with the Cordis getter tracing change in DSH `0.2.2-alpha.3`, reading from the root can still cause the getter to capture the Connection provider's definition context. That provider does not inject `webServer`, so registration fails with `cannot get property "webServer" without inject` and browser requests reach the static fallback.

## Fix and verification

The optional Git child fiber depends on both `connection` and `webServer`. The [compatibility adapter](../../src/compat/dsh-connection-rpc.ts) supplies that fiber as the getter's `ctx`, then registers the channel through DSH's `rpc.handle`. DSH continues to own request authentication and RPC encoding and decoding. The route unloads with the child fiber when either dependency goes away. Profiles without a Web service can still use the Git service.

The [regression test](../../tests/rpc-channel.spec.ts) places the real Connection service and the Web route registry in separate Cordis fibers. Over loopback HTTP, it checks that unauthenticated requests return 401 and that `POST /git/discover` returns 200 with the temporary repository root after receiving a DSH-issued session cookie. It also covers late registration, unload, and remount. In HTTP checks with the WebServer, static fallback, and Connection from DSH `0.2.2-rc.1` and `0.2.2-rc.4`, the old plugin returned 405 for `POST /git/discover`. After the fix, the authenticated request succeeded and POST reached the static fallback again after plugin unload.
