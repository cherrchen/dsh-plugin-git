# 变更日志

[English](CHANGELOG.md) | 中文

本文件记录本 package 的所有重要变更。格式参照 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，版本遵循 [Semantic Versioning](https://semver.org/spec/v2.0.0.html) —— 本包处于 pre-1.0，minor 版本之间仍可能改变 API。每个已发布版本同时有对应的 [GitHub Release](https://github.com/cherrchen/dsh-plugin-git/releases)，附该版本的 tarball。

## [Unreleased]

### Changed

- GitHub Remote 的 PR/Issue 列表、详情评论与比较文件不再受固定分页预算截断。`RemotePage` 携带不透明 `next` 续页游标（经 origin 校验的 `Link rel="next"`），`remote-list-prs`、`remote-list-issues`、`remote-comments`、`remote-files` 接受 `cursor`/`pages` 请求字段。Client controller 以串行后台流追加条目——首请求多页、之后每次续取一页——按 number/评论 id/文件路径去重，逐页校验 generation，并在限流后按 `resetAt` 有界恢复一次。truncated 警示条移除，改为流式提示。
- `remote-files` 续页钉住比较快照：每次续取校验 `expectedBaseSha`/`expectedHeadSha`，行内评论坐标不会跨页漂移。行内评论提交在文件全部加载完成前保持禁用；通知线程展开与写路径坐标校验的有界收集保持不变。
- PR 详情页不再渲染本地文件 diff。新增 `remote-commits`/`remote-reviews` 端点，投影 `RemoteCommit`/`RemoteReview` 模型（review `state` 归一为 approved/changes-requested/commented/dismissed/pending）并沿用同一游标流式加载；文件改动经 `pr.url + '/files'` 链接跳转 GitHub Files 页查看。行内评论只读、按 `reviewId` 嵌套在对应 review 下展示；因无锚点选择器，行内评论提交按钮移除。`remote-files` 与 `remote-inline-comment` 保留为受守护 RPC 能力。详情页同时修复了 load/open 失败后紧密循环重试的问题——每个目标与 revision 只尝试一次。

- PR/Issue 详情页改为 GitHub 风格的时间线。`RemoteIssue`/`RemoteComment` 携带 `createdAt`，`RemoteCommit` 携带 `committedAt`；新增 `RemoteTimeline` 按时间交错排列评论、提交、review 与行内 thread——空的 per-reply review 隐藏、孤儿 thread 独立成项。正文作为开场卡与后续项同槽对齐，详情页改用 20px 横向内边距。
- GitHub 正文不再泄漏原始标签：纯模块 `github-markdown` 先把 GitHub 允许的 HTML 子集（details/summary、注释、图片、链接、强调、code、pre、列表、表格、alert 引用）投影为 Markdown 再交给 `MarkdownText`，`RemoteMarkdown` 用原生 `<details>` 渲染折叠块，全程不接触 `innerHTML`。
- 平台认证弹窗重做为状态卡 + “连接方式”方法行（GitHub 账号登录、本机已有的凭据、Git 凭据助手），每种方式附说明并对当前生效的方法标“当前使用”。`authAction` 接受端点序列、在同一 busy 周期内按序执行、首个失败即停；当已有 grant 或 signed-out/invalid marker 会覆盖所选方式时，Local/Git credential 重连自动前置 `remote-clear-grant`，用流程表达“断开连接（持久 signed-out）”与“清除本地授权”的区别，取代原先五个含义不清的按钮。

- 同一批界面的后续打磨：时间线与认证弹窗标记改为真实 GitHub 头像——`author.avatarUrl` 与 viewer `avatarUrl` 仅经专用 `avatarUrl()` 准入 `https://avatars.githubusercontent.com`——失败或缺失时回退为首字母圆点，并保持不透明以遮住时间线竖线。认证弹窗加宽至 440px，并简化为状态卡加 GitHub CLI / GitHub OAuth 单选组，选中态只由 capability 派生；Git 凭据端点仍保留在 `remote-use-git-credential` 之后。

## [0.2.7] — 2026-10-17

### Changed

- 精确 DSH 支持清单纳入 `0.2.1-rc.2`，验证范围覆盖 `0.1.5-rc.2` 至 `0.2.1-rc.2` 的全部已发布版本。manifest 同时新增 `engines.dsh` 声明，内容与精确版本集合一致——自 `0.2.1-alpha.4` 起宿主准入预检在该字段存在时只读它——`pnpm compat:check` 强制其与 peer 范围同步。

## [0.2.6] — 2026-10-15

### Added

- 新的 **Git Worktrees** 侧栏页（`git.worktrees`）列出当前仓库的全部检出——不论其创建来源——并标记当前检出，提供 **在此会话中使用** 与创建对话框（可选分支名与起始提交）。仅当宿主通过新增的 `worktree-capability` RPC 报告创建模式时，该 tab 才注册。
- `create-worktree` RPC 与 `GitService.createWorktree`：宿主挂载上游实验性 `worktrees` 服务时创建委托 `ctx.worktrees.create(agent, ...)` 并自动进入新检出；否则 `git-worktrees` 的 `enabled` 设置开启本地 `git worktree add -b` 实现，检出池默认 `.agents/worktrees`，可经 `worktrees.directory` 修改。宿主挂载 `fs` 服务时，新建的仓内检出池会写入自我忽略的 `.gitignore`。删除与修剪仍不属于本包。
- 新的 `git-worktrees` 设置节在两种受支持的设置面上编辑 `enabled` 与 `directory`；保存后重新轮询 capability，Worktrees tab 无需重启即可出现或消失。

### Changed

- 插件配置卡全面改用 `@deepseek-ai/dsh-client-ui-primitives` 原生控件：生成模型合并为一个下拉框，会话模型置于按 provider 分组的目录条目之上；Worktrees 启用项使用原生胶囊开关。
- 插件 bundle 页上的两个设置节现在合并为一个通宽设置表单、共用一个保存按钮——宿主导出 `SettingsForm` 时使用原生框架（DSH ≥0.1.7），更早版本使用样式一致的本地框架——离开页面时丢弃暂存修改。旧版命名空间卡片保留各自的控件。
- 精确 DSH 支持清单现已覆盖 `0.1.5-rc.2` 至 `0.2.1-alpha.3` 的全部已发布版本：`0.1.5-rc.3` 与 `0.2.1-alpha.1` 此前经验证补入，区间内不再有缺口。
- `scripts/upgrade-dsh.mjs` 与 `pnpm compat:check` 接受不带 caret 或波浪号的精确宿主运行时 pin，与以精确版本声明 Cordis、schemastery 的发行版一致（`0.1.5-rc.3` 即如此）。

### Fixed

- 共享配置页依次等待各设置节保存后再使用新 revision 写入下一节，保存中关闭页面仍会完成请求。传输失败后保留可编辑草稿供重试；关闭本地工作树会显式覆盖组合配置的 `true` 默认值。
- 工作树创建发布的新目录投影不再取消自身的成功 RPC 回执；控制器卸载仍会取消在途创建。
- 同目录侧栏挂载不再取消共享刷新或清空提交草稿。可执行文件首次查找被取消后不再污染后续 Git 请求或其他会话；成功刷新同时更新会话能力。Changes 与 Graph 会显示仓库加载失败原因。
- 上游工作树创建要求当前会话有活 agent，已打开弹窗中的提交也受此约束；本地检出池目录提示仅在本地模式显示。

## [0.2.5] — 2026-10-11

### Added

- 工作树控件会列出当前会话仓库的链接检出。宿主提供工作目录服务且会话有活 agent 时，**在此会话中使用** 会将该会话切换到所选检出。

### Changed

- Git 仓库状态跟随每个会话的有效工作目录，包括宿主投影的目录变更；旧宿主继续使用会话原始目录。
- Git 0.2.5 支持 DeepSeek Harness `0.2.1-alpha.2`，包括会话有效工作目录与链接工作树切换；`0.2.1-alpha.1` 仍不受支持。

### Fixed

- `git worktree list --porcelain -z` 的路径保留 Git 报告的空白，**在此会话中使用** 会进入该检出。
- 会话没有活 agent 时不显示 **在此会话中使用**，即使宿主已经挂上目录服务。
- 重叠的工作树进入请求按顺序执行，当前这次目录切换结束前进入按钮保持禁用。

## [0.2.4] — 2026-09-30

兼容性版本：精确 DSH 支持清单扩展至 `0.2.0-rc.2`，开发 pin 同步切到该发行版。

### Changed

- Git 文件比较改为复用官方 DSH `DiffBlock`，删除插件自写的逐行渲染器与样式。插件保留 Git 取数和侧栏地址，继续支持现有 DSH 矩阵，并区分二进制、仅元数据、空 patch、不完整输出及末尾换行变化。复制和折叠由 DSH 提供，新宿主还提供换行控件。

- 精确 DSH 兼容矩阵加入 `0.2.0-rc.1` 与 `0.2.0-rc.2`。开发依赖与提交锁文件 pin 在 `0.2.0-rc.2`（Cordis `4.0.4`、schemastery `3.18.4`）。`src/compat/` 里已有的设置、schema 与图标结构探测继续覆盖这两个版本。该 pin 发布的车道专用包（`dsh-util-code-language`、`dsh-client-shortcuts`）只作为开发依赖，不进入 peer OR。

### Fixed

- 主 CI 冻结安装可以在 pnpm 24 小时发布冷却到期前解析开发 pin `0.2.0-rc.2`：`minimumReleaseAgeExclude` 只保留该 pin 在锁文件中的精确包。pnpm 11.7 会忽略同一包名的后续 `name@version` 行，因此不再把旧 pin 条目留在旁边。未列入清单的 prerelease 不进该列表。

## [0.2.3] — 2026-09-25

兼容性版本：精确 DSH 支持清单扩展至 `0.1.7-rc.2`，升级车道对仅 rc.2 发布的包使用条件 devDependencies。

### Changed

- 精确 DSH 兼容矩阵加入 `0.1.7-rc.2`。开发依赖仍 pin 在 `0.1.5-rc.2`。`src/compat/` 里已有的设置、schema 与图标结构探测继续覆盖该版本。
- 升级脚本仅在目标精确版本发布了 `@deepseek-ai/dsh-util-code-language` 与 `@deepseek-ai/dsh-client-shortcuts` 时，才把它们写入该车道的开发依赖。它们不进入 peer OR，因此旧宿主仍可加载。

## [0.2.2] — 2026-09-24

兼容性版本：精确 DSH 支持清单覆盖至 `0.1.7-rc.1`，`src/compat/` 按结构探测做跨版本适配，peer 改为由该清单生成的 OR 范围，使旧宿主继续加载、新发行版同时可支持。

### Changed

- 精确 DSH 兼容矩阵现支持 `0.1.5-rc.2`、`0.1.6-alpha.1`、`0.1.6-alpha.2`、`0.1.7-alpha.1`、`0.1.7-alpha.2` 与 `0.1.7-rc.1`，开发依赖仍 pin 在 `0.1.5-rc.2`。
- 所有 `@deepseek-ai/dsh-*` peer 改为由该清单生成的精确 OR 范围，不再使用单一的 `>=0.1.5-rc.2 <0.2.0` 区间。
- `src/compat/` 内的跨版本适配按结构探测、不按版本号分支：提交信息设置在 `settingsScope` 与 `configForms` 间桥接；图标把旧固定尺寸导出映射到 0.1.7 权重 glyph；schema 仅在宿主 schemastery 副本提供 `.volatile()` 时标记字段，并通过 `readVolatile` 读取 volatile 引用快照。
- `.pnpmfile.cjs` 把传递链上的 `@deepseek-ai/dsh-*` 统一改写为当前 pin，避免 caret peer 把锁文件漂到更新的 prerelease。
- `.github/workflows/upgrade.yml` 的回归矩阵由支持清单动态生成；升级脚本把 Cordis 与 schemastery 钉到各发行版声明的 caret 或波浪号下限（含 `0.1.7-alpha.2` 与 `0.1.7-rc.1` 的 `~4.0.4` / `~3.18.4`）。
- Client 工作区读取和插件设置卡片注册已适配 alpha.2 的 Session 列表与 Plugins 标签页接口变化。

### Fixed

- 在上游 DSH bundle 导入但未声明运行时依赖时，将 `simple-icons`、`zustand` 与 `immer` 声明为 peer（`dsh-client-ui-primitives`、`dsh-client-store`）。

## [0.2.1] — 2026-09-14

文档与可靠性版本：新增变更日志与贡献指南，[安装](README.zh.md#installation)一节文档化全部四种安装来源，焦点抖动不再叠加仓库刷新。

### Added

- `CONTRIBUTING.md`（中文副版 `CONTRIBUTING.zh.md`），说明环境搭建、质量门禁与文档义务。
- `CHANGELOG.md`（中文副版 `CHANGELOG.zh.md`）。

### Changed

- [安装](README.zh.md#installation)一节改为文档化四种安装来源 —— npm 注册表、tarball、本地路径、GitHub/git —— 取代原先的"一条 npm 命令 + 一段本地开发片段"。
- 新增 `prepare` 脚本（`pnpm run build`），使 GitHub/git 安装会在安装方机器上从 `src/` 构建 `lib/`。
- `pnpm docs:check` 现在同时校验仓库根的三对双语文档：`README`、`CONTRIBUTING`、`CHANGELOG` 都必须有 `.zh.md` 副版与 `*.i18n.yaml` 一致性记录。

### Fixed

- 焦点抖动不再叠加仓库刷新：`GitClientController.refresh()` 对同一工作区复用在途往返，反复的焦点事件只对应一对 `discover`/`status`，而不是互相判旧、让 `repository` 迟迟不落地的多轮重叠请求；请求若在该轮已读取仓库之后到达（外部编辑后的焦点回归），该 burst 会补读一轮，合并进来的调用方等到这轮补读落地（含共享轮次以瞬时错误收尾的情形——失败不得吞掉请求），每个 burst 最多两轮，避免控制器自身的 Host 流量自激。背景见 [Windows 桌面端终端窗口风暴](docs/troubleshooting/windows-desktop-console-flood.md)。

## [0.2.0] — 2026-09-14

首次公开发布：`@dsh-electron/dsh-plugin-git@0.2.0` 已带构建 provenance 发布到 npm，其 GitHub Release 附同一个 tarball。

### Added

- Changes 与 Graph 标签页的实时标题。
- `pnpm version:major` / `version:minor` / `version:patch` 快捷脚本，与 `version:set` 并列。
- 新增规格：client 的 CSS module class 若未出现在构建产物样式表中即失败。

### Changed

- **对 Client 半部是破坏性变更：Git 各 surface 从第三方 Details Host 迁移到上游右侧边栏。** 本包此后面向 DeepSeek Harness ≥ v0.1.5-rc.2，把 `git.changes` 与 `git.graph` 注册为 page tab type、`git.diff` 注册为 `dsh-resource://git/diff/**` resource type，并统一经 `ctx.sidebarRight` 导航。
- 所有 `@deepseek-ai/dsh-*` peer 范围改为 `>=0.1.5-rc.2 <0.2.0`。
- Diff 结果改为面板局部状态，不再写入共享的 controller slot。
- 面板头部动作复用共享的 `GitIconButton`。

### Fixed

- 回环 `/git` RPC 通道只在 `webServer` 出现后挂载，并从根上下文读取 connection service，不再在 `connection` 尚未解析时注册。
- Changes 或 Diff 面板刷新失败时，错误会与面板拉取错误一同展示，不再被丢弃。
- `npm publish` 收到的 tarball 参数改为 `./dist/<name>.tgz`：裸 `dist/<name>.tgz` 会被 npm 当作 GitHub `owner/repo` 简写解析并失败。

### Removed

- `@dsh-electron/dsh-client-ui-details-host` 依赖及其钉住的 fixture tarball。

## [0.1.0] — 2026-09-13

首个 tag 版本：一项 portable Host service、一份 Client bundle 与一个 optional Desktop enhancement。

### Added

- `ctx.git` Host service。它要求 `ctx.subprocess`，以 executable 加独立 argv values 启动 Git、绝不调用 shell：repository discovery、Git version、current branch 与 HEAD、porcelain v2 status（staged／unstaged／untracked，NUL 分隔路径）、local branches、working tree 与 staged diffs、stage／unstage、commit、amend、向 `origin` push、rebase-then-push sync、branch creation 与 branch switching。
- 破坏性的 discard：通过明确的 index、working tree 与 clean 步骤还原一条 staged、unstaged 或 untracked 变更，且始终在 Client 端要求第二次确认。
- 分页提交历史（`git log`，每条 commit 一行定长字段），Graph surface 通过 load-more 控件增量追加更早提交。
- Commit message 生成：staged diff（受 `commitMessage.maxDiffBytes` 上限约束）发送到宿主 LLM runtime —— 会话模型，或插件配置中固定的 `provider`/`model` 路由 —— 流式建议写入可编辑的 message 输入框。它绝不 stage、commit 或 push。
- 基于第三方 Details Host（当时为必需依赖）的 Client surfaces：**Changes**（branch、带 Generate 的 commit message、分裂式 Commit 按钮、staged／unstaged／untracked 分区）、**Diff**（每标签页一个文件）、**Graph**（canvas lane graph，Auto／All／First parent 三种 scope，最多可见三条 lane，增量分页）。
- 会话输入区的 composer 控件 —— branch selector 与 changed-files indicator —— 用于打开 Git surface，以及共享的 create-branch modal（处理 unborn HEAD）。
- 面向 DSH Web host 的回环 `/git` RPC channel，以及 `cordis.patch.yml` bundle 层，使一次 `dsh plugin add` 即可把插件挂进 profile。
- 可选的 `ctx.inject(['desktop'], ...)` child fiber，使用 `shell.showItemInFolder`、`shell.openPath` 与 `notification.show`。
- `docs/` 文档库、`pnpm docs:check` 机器校验、`version:set` 脚本、tag 触发的 release 工作流、双语 README 配对及其 `README.i18n.yaml` hash 记录。

[Unreleased]: https://github.com/cherrchen/dsh-plugin-git/compare/v0.2.7...HEAD
[0.2.7]: https://github.com/cherrchen/dsh-plugin-git/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/cherrchen/dsh-plugin-git/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/cherrchen/dsh-plugin-git/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/cherrchen/dsh-plugin-git/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/cherrchen/dsh-plugin-git/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/cherrchen/dsh-plugin-git/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/cherrchen/dsh-plugin-git/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/cherrchen/dsh-plugin-git/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/cherrchen/dsh-plugin-git/releases/tag/v0.1.0
