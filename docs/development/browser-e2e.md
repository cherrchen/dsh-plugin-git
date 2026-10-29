中文 | [English](browser-e2e.en.md)

# 隔离浏览器 E2E

- **Status**: Current

## 运行

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm test:e2e
```

Linux CI 安装浏览器时使用 `pnpm exec playwright install --with-deps chromium`；PR / main 的 CI 已执行此套件。本机已有 Chrome 时可用 `DSH_E2E_BROWSER_CHANNEL=chrome pnpm test:e2e`，Playwright 仍使用独立临时用户目录，不连接日常浏览器 profile。Windows 可先在 shell 中设置同名环境变量，再执行测试。

测试入口为 `playwright.config.ts` 与 `tests/e2e/auth.e2e.ts`。Playwright 启动只监听 `127.0.0.1:4179` 的专用 Vite fixture 服务；端口已占用时拒绝启动，不复用其他服务。测试串行执行，每个场景创建独立的内存凭据存储与临时 Git 仓库。失败保留截图、trace 和错误上下文到 `test-results/e2e/`；该目录与 Playwright 报告均不纳入版本控制。

可以设置 `DSH_E2E_OUTPUT_DIR` 为仓库外的绝对路径，以保存失败截图和 trace 而不覆盖主工作树内的测试产物。

## CI 跨平台验收

[主 CI](../../.github/workflows/ci.yml) 在 PR（含 Draft）和 main push 上，以开发 pin 分别运行 `ubuntu-latest`、`windows-latest`、`macos-latest`，失败不取消其他系统。每条车道执行冻结安装、兼容门禁、完整单测、A1/A2/A3 验收探针、Chromium E2E、文档检查、构建、artifact 检查和打包。Git fixture 统一关闭 autocrlf；命令失败分类使用真实 Git 的损坏配置 fixture，避免依赖 POSIX shell。浏览器使用 list + HTML reporter，报告与失败 trace 按系统分别保留 14 天。

路径断言比较真实文件系统身份，不依赖 Git 的分隔符或 Windows 临时目录的短路径拼写。RPC 测试适配器按 Windows 的大小写不敏感环境变量名及 `PATHEXT` 查找 Git；真实文件名使用各系统允许的字符，双引号显示路径另用合成 patch 验证。生产路径身份规则见[架构总览](../architecture/overview.md)。

DSH 其余 17 个精确 release 继续由 [兼容矩阵](../../.github/workflows/upgrade.yml) 在 Ubuntu 回归；操作系统矩阵和 release 矩阵分别验证，不把它们声称为全部 release × OS 的笛卡尔积。CI 结果应关联当前 PR head，排队/运行中不表示验收通过。此自动验证覆盖可移植 Host/Git 和浏览器 Client fixture；真实账号、自建 GitLab、完整 DSH Web/Desktop 启动与原生增强卸载仍需独立环境证据，见[远程计划](../plans/active/remote-platform-integration.md)。

## 隔离与验证边界

浏览器实际运行仓库的 `RemoteAuthControl` / `RemoteAuthSection`、Client 控制器与 capability store，经 loopback HTTP 适配器调用真实 `GitRemoteRuntime`、认证引擎以及 GitHub/GitLab Provider。Git 仓库读操作执行真实 `git`，使用临时 HOME / USERPROFILE / XDG_CONFIG_HOME / GH_CONFIG_DIR，并隔离全局与系统 Git 配置，不读取用户的 helper 配置或令牌环境变量。

外部 GitHub OAuth / REST、GitLab API 服务和 gh / credential helper 探针由确定性 fixture 替代，只发放 synthetic sentinel 令牌；后端拦截出站请求，浏览器拒绝非 loopback 请求。测试不访问真实 GitHub，不修改用户现有授权、不打开真实授权页，也不向真实远端发送写操作。fixture 控制端点只在测试 Vite 配置中注册，不进入发布包；关闭服务后取消运行时工作并清理临时仓库。

`tests/e2e/device-login.e2e.ts` 覆盖 GitHub/GitLab 自动申请设备码、每 attempt 一次模拟原生浏览器打开、复制、重开弹窗、成功、拒绝、过期、取消和增强失败/卸载后的手工继续；高级清理默认折叠并覆盖键盘展开。模拟原生调用只记录 URL/用户码，不操作真实系统浏览器或剪贴板，不能替代真实 Desktop provider 验收。

浏览器用例覆盖：

- gh、OAuth 和凭据引用的中英文渠道展示；
- 通过“连接方式”单选项切换 CLI/OAuth，复用已保存授权；保留同一 credentials fixture、重建 Host 并刷新页面后再次复用 OAuth；仅退出 OAuth 时 CLI 保持认证；对话框宽度断言与截图；
- 设备码登录从匿名到 OAuth 的完整内部流程，以及取消授权；
- 浏览器 RPC 响应与页面不出现令牌正文；
- 独立浏览器上下文和凭据存储之间的身份隔离；
- GitLab CLI 触发模拟限流后切回已保存 OAuth 恢复列表，无需再次设备授权；重复切换保留原 CLI 的限流窗口且不重复请求服务端；
- GitLab.com 的持久退出标记在首次仓库读取时被发现后，保留正确认证入口且不显示原始错误码；分别用模拟 glab 和 Device Flow 恢复认证并读取列表；
- GitLab 实例前缀、MR 读取、普通评论、审批结果未知后的对账、受限通知与模拟本地 push 建议。

缺失 / 未知渠道和无效认证状态的展示另由 `tests/remote-auth-section.client.spec.tsx` 覆盖；认证变更遇到旧 capability 读取在途的回归位于 `tests/remote-client.spec.ts`。

这是在替代外部服务边界下的浏览器到插件运行时 E2E，不替代真实 GitHub OAuth/SSO、系统凭据助手兼容性或完整 DSH 宿主集成验收。真实服务验收状态继续以[远程平台计划](../plans/active/remote-platform-integration.md)为准；认证渠道契约见[远程平台 RPC](../reference/remote-platform-rpc.md)。
