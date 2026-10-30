# 变更日志

[English](CHANGELOG.md) | 中文

本文件记录本 package 的所有重要变更。格式参照 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，版本遵循 [Semantic Versioning](https://semver.org/spec/v2.0.0.html) —— 本包处于 pre-1.0，minor 版本之间仍可能改变 API。每个已发布版本同时有对应的 [GitHub Release](https://github.com/cherrchen/dsh-plugin-git/releases)，附该版本的 tarball。

## [Unreleased]

### Added

- 插件设置页新增“平台账号”分区，可查看并管理 GitHub/GitLab 登录。

### Changed

- 远端与本地 Git 操作错误改为 toast 呈现：显示简短本地化摘要，原始错误码与已放行 details 仅经“复制详情”操作查看，面板不再内联红色错误文案，首载失败仅保留同色提示行

- 平台认证弹窗重构为“{平台} 账号”：身份卡 + 带说明的连接方式卡片；“已移除实例的授权清理”从弹窗“高级”折叠区移至设置页“平台账号”分区。
- 将 DSH 兼容范围扩展至 `0.2.1-rc.4` 与 `0.2.2-alpha.2`（含可选 credentials seam），接受其宿主 Cordis/schemastery 副本，保留全部旧版支持与 `0.2.0-rc.2` 开发 pin。见[兼容评估](docs/reference/dsh-compatibility.md)。
- 将 DSH 兼容范围扩展至 `0.2.1-rc.5`：该版本仅有 manifest 重发，其推理块 Slot 契约变化不在本插件使用面内；宿主运行时下限、Node 车道与开发 pin 均不变。见[兼容评估](docs/reference/dsh-compatibility.md)。
- 隔离 DSH 矩阵车道快照补上 `oauth-apps.json`，使车道安装可以执行独立 bundle 构建。
- 隔离本地矩阵支持未列入清单的候选验证；联网车道使用干净依赖树并检查 peer，避免遗留 Cordis 配套包。0.2.2 alpha CI 车道使用 Node 24.9，并修正开发锁文件的 include peer 解析。

### Fixed

- GitLab 认证 generation 变化后会撤回旧条目、游标与筛选缓存，新读取或续页失败也不保留旧身份内容。
- 本地 Git 失败在同一控制器下只显示一条共享 toast，编辑器与侧栏面板按实际失败操作显示一致文案。
- 平台账号支持完整的 16 个自建实例加内建 GitLab.com 与 GitHub 配置。
- GitHub 有作用域写操作的对账现会等待详情全部续页完成后再开放确认；续页失败或刷新被取代时继续阻止重复写入。
- 平台账号重新发现后会刷新已显示的 GitLab 能力，覆盖同 URL 配置变化与重进设置页，并避免打断设备码登录或形成轮询循环。

- 复制错误详情时，剪贴板 API 不可用或写入器同步抛错均会显示失败提示。
- 远端写入受阻提示现会显示详情复制成功或失败的反馈，并保留核对确认操作。
- GitLab 认证账号与作者头像现可显示（含 Gravatar 默认头像）。

## [0.2.8] — 2026-10-25

### Added

- 新增右侧栏可移植 GitHub Remote 工作流：PR/Issue 浏览、独立详情标签页、PR 评论与 review、核验 PR checkout、Issue 分支，以及从已推送分支创建 PR、关闭和合并等受保护操作。Remote 需要宿主完整可选 credentials seam；旧宿主保持本地 Git 可用并关闭 Remote。平台登录不配置 Git fetch/push 认证；外部平台验收继续由[远程集成计划](docs/plans/active/remote-platform-integration.md)跟踪。
- 新增平台认证弹窗，显示当前凭据来源与账号，提供 GitHub CLI、已配置的 OAuth 设备码登录、重连和断开连接流程，并隔离凭据生命周期。运行时继续支持凭据引用与 Git 凭据助手。
- 新增隔离浏览器 E2E，覆盖认证来源的中英文展示、断开与重连、设备码登录与取消、令牌不泄漏及独立浏览器上下文。

### Changed

- 将已验证 DSH 支持扩展至 `0.2.1-rc.3`，同步唯一版本清单、`engines.dsh` 与精确 peer 范围（含可选 credentials seam）。既有结构适配层兼容导航自定义与模型发现；开发 pin 保持 `0.2.0-rc.2`。
- GitHub PR/Issue 列表、评论、提交、review 与比较文件改为游标渐进加载，支持去重、取消、generation 校验与限流恢复。`RemotePage.next` 与 `cursor`/`pages` RPC 字段取代固定分页预算；文件续页校验 `expectedBaseSha`/`expectedHeadSha`，保持比较快照稳定。
- PR/Issue 详情使用按时间排列的时间线，交错展示评论、提交、review，以及归属 review 的只读行内 thread；文件改动跳转 GitHub Files 页面。GitHub Markdown 与受支持 HTML 经宿主 Markdown 组件渲染，使用原生 details 折叠块与经过校验的 GitHub 头像。
- Remote 界面改用上游 primitives 与资源标签页；Git 导航入口集中排列，图谱与远程图标更清晰，本地 Git 视图在切换后保留缓存，远程加载进度持续可见且保持响应。
- 补充包含新版必需事件时，上游 Session 日志的降级回读边界说明。

### Fixed

- 修复详情加载或外部打开失败后，对同一目标与 revision 紧密循环重试的问题。
- 支持从暂时的 viewer 查询失败恢复，拒绝越界的 GitHub 数值实体标识。
- 保持旧宿主的 Markdown 渲染与 Client bundle 兼容。

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

[Unreleased]: https://github.com/cherrchen/dsh-plugin-git/compare/v0.2.8...HEAD
[0.2.8]: https://github.com/cherrchen/dsh-plugin-git/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/cherrchen/dsh-plugin-git/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/cherrchen/dsh-plugin-git/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/cherrchen/dsh-plugin-git/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/cherrchen/dsh-plugin-git/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/cherrchen/dsh-plugin-git/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/cherrchen/dsh-plugin-git/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/cherrchen/dsh-plugin-git/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/cherrchen/dsh-plugin-git/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/cherrchen/dsh-plugin-git/releases/tag/v0.1.0
