中文 | [English](overview.en.md)

# 当前架构总览

- **Status**: Current（以下均可用当前仓库与测试验证）

## 组成

```text
┌─ Host（Cordis plugin，src/index.ts + src/service.ts）──────────┐
│ requires ctx.subprocess，provides ctx.git                      │
│ 每条 git 命令 = 可执行文件 + 分离 argv，绝不 shell              │
│ 可选 Connection 子 fiber：注册 loopback /git RPC 通道           │
└──────────────┬─────────────────────────────────────────────────┘
               │ RPC（status / diff / log / stage / commit / branch …）
┌─ Client（src/client/）─────────────────────────────────────────┐
│ 主 fiber：全部 portable 贡献                                    │
│  · composer 分支选择器 + 变更文件指示器（slot 注入）             │
│  · 三个常驻右侧边栏 tab type：git.changes / git.diff /        │
│    git.graph，以及随 worktree-capability 动态注册的            │
│    git.worktrees                                             │
│  · 设置卡（compat：设置卡或组合包详情）：git-commit-message   │
│    与 git-worktrees                                          │
│  · commit message 生成（host LLM runtime，建议式）              │
│ 子 fiber ctx.inject(['desktop'])：reveal / openPath / 通知      │
└────────────────────────────────────────────────────────────────┘
```

## 关键结构事实

- **Host service**：通过 `ctx.subprocess` 启动 `git`（可执行名或绝对路径 + 分离 argv）。每条命令的 cwd 是调用方给出的仓库路径，或在宿主提供工作目录服务且会话 agent 仍活着时，是该会话有效目录所在的检出根。不使用进程级 `process.cwd()`。Status 用 porcelain v2 + NUL 路径分隔；branches 用 `for-each-ref`；commit 历史用固定字段数的分页 `git log`（`GIT_LOG_FORMAT`），Graph 据此增量加载。检出种类与 `git worktree list --porcelain -z` 一起放进同一次 status；`-z` 记录里的路径按 Git 原文保留，不裁掉首尾空白。Git 不支持 `-z` 时退回换行形式。丢弃（discard）通过显式的 index / worktree / clean 操作序列实现，Client 侧强制两步确认。
- **会话目录**：Client 从会话列表读取有效目录：投影 `workingDirectory` 为非空字符串时使用它，否则使用会话头 `cwd`。这是宿主已有投影，插件不另建目录数据库。目录变化会取消旧工作区的读取与尚未发出的写操作；已发出的工作树创建单独等待回执，以免自身发布的目录投影取消成功结果，控制器卸载时仍取消该请求。其余在途 Git RPC 随绑定取消。写操作在宿主侧还要核对请求仓库是否仍是该有效目录的检出；对不上就拒绝，不把结果套到新检出上。每个会话一个 controller。
- **Worktree 边界**：本包发现同一仓库的全部检出（来源不限），并在宿主 `workingDirectory.set` 可用且该会话仍有活 agent 时，让用户把**当前这个会话**切到列表中的另一个检出。专用 Worktrees 侧栏 tab（`git.worktrees`）按 `worktree-capability` RPC 上报的模式动态注册：宿主挂载上游实验性 `ctx.worktrees` 时为 `upstream`——创建委托 `ctx.worktrees.create(agent, ...)`，上游成功后自己切换会话目录，Git 界面跟随投影刷新；未挂载且 `git-worktrees` 设置的 `enabled` 为真时为 `local`——`GitService.createWorktree` 用 `git worktree add -b`（检出池默认 `<仓库根>/.agents/worktrees/`，可在设置中改，可选 `ctx.fs` 只为占用检查与池 `.gitignore` 标记），随后经会话目录服务进入新检出；两者皆无时为 `off`，tab 类型随之注销。Client 在插件挂载时及每 5 秒轮询 capability；设置保存后立即请求刷新，在途轮询后补一次刷新以避免旧响应遮蔽设置变化。tab 注册与全部会话控制器共享同一份能力状态，因此启停本地模式或挂载/卸载上游运行时无需重新绑定工作区；插件卸载时停止定时器并解除会话订阅。绝对检出池目录（包括 Windows UNC 与根路径）保持原样，相对路径按仓库根解析。上游运行时的探测是结构性的（服务提供 `create` 方法），不引入实验包依赖。删除与修剪仍不在本包内。同一次目录切换或创建尚未结束时，下一次排队执行，进入按钮保持禁用。
- **RPC**：DSH Web 宿主存在时，Connection 子 fiber 注册 loopback `/git` 通道；过期输出（stale mutation）被丢弃，文件名按字面 pathspec 处理。
- **Client 刷新合并**：`GitClientController.refresh()` 对同一工作区复用在途刷新（复用键为 `path` + `operationGeneration`，只有同 `generation` 才复用；轮次结束在 `finally` 中释放槽位）。复用只在该轮尚未发出 `status` 读取时成立；请求在该轮读取之后到达时，该轮记一次 trailing 读取，合并进来的调用方 await 到这轮 trailing 读取落地，共享轮次失败（瞬时错误）也不例外——请求的依据是「读取已发出」，与那轮成败无关。一个 burst 最多两轮往返（trailing 不再递归链接，避免控制器自身的 Host 流量——Windows 下每条 git 命令弹出的控制台窗口带来的焦点事件——自激成永久循环）。composer 控件的 `window` focus 监听因此不会在焦点抖动时叠加多轮 discover/status，也不会让重叠轮次互相判旧。背景见 [troubleshooting](../troubleshooting/windows-desktop-console-flood.md)。
- **Client 页签缓存**：Changes / Worktrees 挂载不再额外强刷；各 surface 共用 `setWorkspace`，同目录 5 秒内直接复用会话快照，过期重入时保留画面并刷新，手动刷新和写操作不受新鲜度限制。Graph 继续保留已取历史，仓库刷新或变更会使其失效。Diff 的每个路径/侧缓存最多保留 5 秒（每会话最多 32 项），仓库快照替换、目录重绑定与 `navigation.revision` 变化使对应结果失效；错误不缓存。远程视图另有更长的新鲜度窗口及按页条件更新，具体策略唯一参考为[远程平台 RPC](../reference/remote-platform-rpc.md#client-缓存与增量校验current)。缓存均为当前 Client 内存，不跨重启持久化。
- **右侧边栏集成**：Client manifest 以 `inject` 声明运行时依赖 `ctx.sidebarRight` / `ctx.sidebarRightTabs`；对 sidebar 包只有 `import type`（动态 plugin 不得 import 其他包的运行时值），bundle 中类型被擦除，故无 `external`。阶段一向 `ctx.sidebarRightTabs.register` 注册三个常驻 tab type（changes/graph 是 page type，diff 是 resource type，pattern `dsh-resource://git/diff/**`），worktrees page type 则订阅 `worktree-capability` 轮询结果随模式动态注册/注销（fiber 卸载时一并注销）；remote 的 `git.remote` page type 与 remote item 的 `git.remote.item` resource type（pattern `dsh-resource://git-remote/<owner>/<repo>/<kind>/<number>`）随 `remote-capability` 的 on/off 同步注册/注销。阶段二把各 body 注入 `sidebar.right.pane.tab` 座（key 为 definition id）。导航统一走 `ctx.sidebarRight.openTab(kind)` 与 `openResource(address, { params })`：changes/graph 由侧栏按 kind 每 pane 去重，diff 与 remote item 以精确地址为 tab 身份，重复打开 reveal 既有 tab 并递增 `navigation.revision`；参数类型通过 `SidebarRightResourceParamsMap` 模块扩充。tab 栏、guide 页、停靠几何与面板宽度由右侧边栏（基于 ui-dockkit）拥有。Diff 结果是面板局部的：controller 的 `fetchDiff` 按路径与 staged 侧独立缓存并合并在途读取，每个 Diff surface 持有自己的在途请求与结果（按仓库根 + tab 地址为键，乱序完成互相不可见），故分屏、浮动窗口与同文件的 staged/worktree 两个 tab 永不互串正文。changes/graph/worktrees 另在 `sidebar.right.pane.tab.title` 座注册 live title（diff chip 是语言无关的文件名，remote item chip 是地址解析出的 `PR #n`/`议题 #n`，均不注册），已打开的 chip 随语言切换更新，而非冻结在打开时刻的文本。provider 卸载只移除 tab type 注册，保留 tab 记录：上游 body 座转为其 "unavailable" 兜底，重新注册后正文恢复。
- **Diff 显示**：插件不再维护逐行 patch 渲染器；`GitDiffSurface` 只负责 Git 取数、面板状态与侧栏适配，正文交给 `@deepseek-ai/dsh-client-ui-primitives` 公开导出的 `DiffBlock`。`git-diff-adapter.ts` 用已有 `diff` 包的 `parsePatch` 把 Git unified patch 转成组件接受的 old/new 文本片段，显示路径取用户选择的字面路径，不从 Git 引号头部反推。复制、折叠与新宿主的换行控件由官方组件拥有；Git 的工作区/index/HEAD 比较不转换成会话回合快照。二进制、仅元数据更改、空 patch 与不完整 patch 分别显示状态；末尾换行差异另有说明，因为官方组件会归一化行终止符；适配器分别记录旧、新文本是否缺少末尾换行，仅两侧状态不同时显示提示，双方均缺少换行（包括共享上下文中的标记）不算换行差异。支持版本上的上下文与 labels 差异集中在 `src/compat/dsh-diff.ts`，见[兼容性参考](../reference/dsh-compatibility.md#官方-diffblock-接入)。
- **远程平台（ADR-0004）**：`src/remote/` 的 credentials 子 fiber 拥有认证/刷新、REST provider、账户缓存与取消/drain；完整 seam 下 RPC 已接入，缺失/不完整时整功能 off。capability 零网络/子进程，storage/auth/viewer/权限各自独立。Client 主 fiber 按 capability 动态注册 `git.remote` page type/body/title 与 `git.remote.item` resource type/body：列表页提供 PR/Issue 列表、过滤与建 PR 入口，条目详情（描述、评论、文件比较与受保护写）打开为以 `dsh-resource://git-remote/<owner>/<repo>/<kind>/<number>` 地址为身份的共享 detail tab，PR 与 Issue 共用一个 body 按导航负载分派；平台认证入口收进工具栏图标按钮的 dialog。作用域协议与 GitLab 实例通过独立 provider/注册表装配；GitLab Host 读取、本地 Git、受守护远端写与可移植 Client 已通过自动阶段验证；已移除实例可经纯存储 retire 清理。原生通知只是可卸载增强。Git checkout 用私有 ref、SHA 核验、tracking CAS 和部分回执；OAuth 不进入 Git 传输。模型/坐标是浏览器安全模块，可选 seam 使用本地结构类型以支持无包旧车道；发布依赖仍用 registry optional peer。细节唯一参考为[远程平台 RPC](../reference/remote-platform-rpc.md)，阶段及尚未执行的真实 OAuth/平台/矩阵验收见[计划](../plans/active/remote-platform-integration.md)。
- **可移植 / 原生分离**：主 fiber 不 require `desktop`；子 fiber `ctx.inject(['desktop'], ...)` 只接受 `shell.showItemInFolder`、`shell.openPath`、`notification.show`。缺 Desktop 时核心操作全部可用，仅原生动作不显示。
- **Graph layout engine**（`src/client/graph/`）：纯逻辑模块——不访问 Git、不依赖 React、不触碰 DOM，可独立测试；输出 geometry 与 Canvas 2D 绘制解耦。设计决策与不变量见 [Git Graph Layout Engine](../reference/git-graph-layout.md)、[ADR-0001](../decisions/ADR-0001-graph-lane-not-owned-by-branch.md)、[ADR-0002](../decisions/ADR-0002-graph-lane-cap-max-three-lanes.md)。
- **Commit message 生成**：Host 侧独立 LLM 请求（不经会话上下文，无 KV Cache 影响）；需要 LLM runtime 与可解析模型，否则 Client 报告 `git/generation-unavailable`。配置结构见根 README [Configuration](../../README.md#configuration)（canonical）。

- **加载与取消恢复**：同目录界面挂载不因 refresh 的结果 generation 变化而重新绑定；成功 refresh 会更新会话能力。Host 只缓存成功的 Git 可执行路径，请求取消或查找失败不污染后续请求。Changes / Graph 显示 discovery/status 错误，具体故障链和回归验证见 [Git 界面空白与持续 AbortError](../troubleshooting/git-workspace-abort.md)。
- **配置保存**：bundle 页共用一个保存按钮，各设置节依次等待保存完成后再读取共享 ConfigForm 的新 revision；保存过程中离开页面不丢弃待保存的下一节。写入拒绝或传输异常保留草稿、恢复编辑与重试，关闭本地模式写入显式 `false` 以覆盖组合层默认值。
- **创建入口约束**：Worktrees 的 `upstream` 模式须当前会话目录能力可用（含活 agent）才开放创建，弹窗提交时同样检查；`local` 模式可以在无活 agent 时创建而不进入。检出池目录提示只在 `local` 模式显示，上游创建的目标由上游决定。

## 验证方式

- `pnpm test`（单元 + 客户端规格，临时仓库与机器可读输出）；
- `pnpm test:artifact`（针对构建产物 lib/client.js 的 bundle/manifest 断言）；
- Graph 拓扑不变量：`tests/graph-layout.client.spec.ts`、`tests/graph-history.client.spec.ts`。

## 相关文档

- [requirements](../requirements/scope-and-requirements.md) —— 架构满足的需求与约束。
- [reference](../reference/README.md) —— Graph layout engine 等稳定技术参考。
