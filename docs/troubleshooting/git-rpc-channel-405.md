中文 | [English](git-rpc-channel-405.en.md)

# `/git` RPC 通道返回 HTTP 405

## 症状

客户端显示 `transport failure for /git/discover: HTTP 405`。输入框旁的分支选择器可能消失，Git 侧栏页签也可能无法加载内容。向同一个 Web 宿主发送未认证的 `POST /api/discover` 与 `POST /git/discover`。如果前者返回 401，而后者返回 405 并带有 `Allow: GET, HEAD`，则请求落到了静态资源回退，宿主的 `/git` 通道未注册。

## 根因

DSH Connection 的 `rpc` getter 捕获 `this.ctx` 作为通道注册上下文。`rpc.handle` 在这个上下文中读取 `webServer` 并注册路由。早期版本可通过根上下文读取 Connection 来访问共享服务表。从 DSH `0.2.2-alpha.3` 的 Cordis getter 追踪变更起，根上下文读取仍可使 getter 捕获 Connection provider 的定义上下文。该 provider 没有声明注入 `webServer`，注册会报 `cannot get property "webServer" without inject`，浏览器请求随后落到静态资源回退。

## 修复与验证

Git 的可选子 fiber 同时依赖 `connection` 和 `webServer`。[兼容适配器](../../src/compat/dsh-connection-rpc.ts) 以该子 fiber 作为 getter 读取的 `ctx`，然后通过 DSH 自己的 `rpc.handle` 注册通道。DSH 继续负责请求认证与 RPC 编解码。任一依赖卸载时，通道随子 fiber 移除。没有 Web 服务的 profile 仍可使用 Git 服务。

[回归测试](../../tests/rpc-channel.spec.ts) 将真实的 Connection 服务与 Web 路由注册表放在不同的 Cordis fiber。测试通过本机 HTTP 检查未认证请求返回 401，以及使用 DSH 签发的会话 Cookie 后，`POST /git/discover` 返回 200 和临时仓库的根目录。测试也覆盖延迟注册、卸载与重新挂载。使用 DSH `0.2.2-rc.1` 和 `0.2.2-rc.4` 的 WebServer、静态资源回退和 Connection 做 HTTP 验证时，旧版插件对 `POST /git/discover` 返回 405，修复后认证请求成功，卸载插件后 POST 再次由静态资源回退处理。
