# 范围与需求总览

- **Status**: Current（可用当前仓库验证；用户视角细节以根 [README](../../README.md) 为准）

## 产品定位

标准 DSH/Cordis Git 插件：一个 portable Host service（提供 `ctx.git`）+ 一个 Client bundle（Changes / Diff / Graph 三个详情面）+ 可选的 Desktop 原生增强。同一份产物不改代码即可运行在 DeepSeek Harness Desktop 与标准 DSH Web 宿主；npm scope `@dsh-electron/` 只标识发布者，不代表运行时依赖 Electron。

## 功能需求

以下为主要功能需求索引；面向用户的行为细节 canonical 于根 README 的 [User experience](../../README.md#user-experience) 与 [Git operations](../../README.md#git-operations) 两节，此处不复制。

| 编号 | 需求 |
| --- | --- |
| FR-1 | 仓库发现、Git 版本、当前分支与 HEAD 读取 |
| FR-2 | staged / unstaged / untracked 状态查询（porcelain v2，NUL 路径分隔） |
| FR-3 | 工作区与暂存区 diff 读取；复用官方 `DiffBlock` 显示文件比较，插件只拥有 Git 数据与侧栏适配 |
| FR-4 | stage / unstage / commit / amend / push / rebase-then-push 同步 |
| FR-5 | 丢弃单条变更（含暂存后修改的 add/rename），两步显式确认 |
| FR-6 | 本地分支创建与切换；unborn HEAD 时禁用创建并说明原因 |
| FR-7 | 分页 commit 历史（`git log` 机器可读格式），Graph 增量加载 |
| FR-8 | Canvas 绘制的 lane graph，含 HEAD / branch / tag 装饰与 Auto / All / First parent 视图范围 |
| FR-9 | Composer 内分支选择器与变更文件指示器，点击在右侧边栏打开对应 tab |
| FR-10 | Commit message 生成：staged diff 发送 host LLM（会话模型或自定义 provider/model），流式写入可编辑输入框；仅建议，不 stage / commit / push |
| FR-11 | 生成 system message 可在 Plugin configuration 编辑（`git-commit-message` 命名空间设置卡） |
| FR-12 | Desktop 存在时提供 reveal-in-folder / open-path 原生动作；不存在时核心功能完整可用 |
| FR-13 | 跟随会话有效目录：宿主投影 `workingDirectory` 为非空字符串时用它，否则用会话头 `cwd`。目录变化后 Git 显示新检出，且不得再对旧检出执行写操作 |
| FR-15 | GitHub PR/Issue、认证、比较、PR 评论/review、已推送分支创建 PR、close/merge、SHA 核验 checkout 与 Issue 分支；credentials 硬门禁、身份前置条件、未知写结果与安全行内坐标见远程 RPC 参考 |
| FR-14 | 识别主检出与 linked worktree；专用 Worktrees 侧栏 tab 列出同一仓库的全部检出（来源不限）。进入另一个检出只作用于当前会话，并复用宿主工作目录切换；该会话没有活 agent 时不提供进入。创建 worktree：宿主挂载上游 `worktrees` 服务时委托其创建；未挂载时经 `git-worktrees` 设置的 `enabled` 开关启用本插件的本地实现（检出池默认 `<仓库根>/.agents/worktrees/`，可在设置中改）。不删除或修剪 worktree |

## 非功能需求

| 编号 | 需求 |
| --- | --- |
| NFR-1 | **Portable**：Host core 只依赖标准 DSH 服务，`git` 经 `ctx.subprocess` 以分离 argv 启动——绝不 shell 拼接、不引入 Electron 导入、preload 全局或 Desktop provider 依赖 |
| NFR-2 | **安全**：调用方提供的 path / branch / message 各自作为独立 argv 值，文件名按字面 pathspec 处理；破坏性操作必须二次确认 |
| NFR-3 | **可独立安装与发布**：依赖一律 registry semver，禁止 `workspace:`；UI 宿主是上游内置右侧边栏，本包对其它 plugin 包仅 type-only import，无第三方运行时配对包 |
| NFR-4 | **有界资源**：单命令输出受 `maxOutputBytes`（默认 8 MiB）限制；生成前 diff 受 `commitMessage.maxDiffBytes` 截断 |
| NFR-5 | **可测试**：使用机器可读 Git 输出与临时仓库测试；拓扑不变量由测试锁定 |

## 约束

- DSH 兼容版本采用精确清单，唯一真源为 [`src/compat/dsh-version.ts`](../../src/compat/dsh-version.ts)；支持声明、升级候选验证与 CI 门禁见 [DSH 兼容契约](../reference/dsh-compatibility.md)。
- Client 主 fiber 包含全部 portable 贡献；原生增强只能放在 `ctx.inject(['desktop'], ...)` 子 fiber，且只声明其消费的结构化方法；provider unload 必须移除增强而保留核心 UI。
- GitHub 与远端凭据工作流已由 [ADR-0004](../decisions/ADR-0004-remote-platform-integration.md)（Proposed，评审闭合待冻结）决议纳入，按 [remote-platform-integration](../plans/active/remote-platform-integration.md) 分阶段实施。Current：完整 seam 下已接入认证、REST 读写、PR checkout、Issue 分支与可移植 Remote UI；无 seam/不完整 seam 仍整功能 off，其他 remote 端点 fail-closed。真实 OAuth、远端写入、平台手工与完整版本矩阵的验收状态见计划日志。契约细节 canonical 于 [远程平台 RPC](../reference/remote-platform-rpc.md)。

## 非目标

以下明确排除（canonical 于根 README [Git operations](../../README.md#git-operations) 末段）：stash、cherry-pick、merge-conflict 编辑。GitHub 认证、hosting provider 工作流、凭据提示、issues、pull requests 已经 ADR-0004 授权进入分阶段实施，不再是永久排除项；当前可用范围与未验证项见远程平台 RPC 和实施计划，不把 mock 验证冒充真实平台验收。删除和修剪 Git worktree 也排除：创建委托宿主上游实验性 `worktrees` 服务（存在时），或由 `git-worktrees` 设置开启的本地实现；本包只发现检出并在宿主目录服务可用且该会话有活 agent 时进入检出。

## 相关文档

- [architecture](../architecture/overview.md) —— 上述需求如何被满足。
- [plans/completed/npm-first-release](../plans/completed/npm-first-release.md) —— 发布约束的现状与已完成记录。
