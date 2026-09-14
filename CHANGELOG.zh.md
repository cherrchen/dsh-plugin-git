# 变更日志

[English](CHANGELOG.md) | 中文

本文件记录本 package 的所有重要变更。格式参照 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，版本遵循 [Semantic Versioning](https://semver.org/spec/v2.0.0.html) —— 本包处于 pre-1.0，minor 版本之间仍可能改变 API。每个已发布版本同时有对应的 [GitHub Release](https://github.com/cherrchen/dsh-plugin-git/releases)，附该版本的 tarball。

## [Unreleased]

### Added

- `CONTRIBUTING.md`（中文副版 `CONTRIBUTING.zh.md`），说明环境搭建、质量门禁与文档义务。
- `CHANGELOG.md`（中文副版 `CHANGELOG.zh.md`）。

### Changed

- [安装](README.zh.md#installation)一节改为文档化四种安装来源 —— npm 注册表、tarball、本地路径、GitHub/git —— 取代原先的"一条 npm 命令 + 一段本地开发片段"。
- 新增 `prepare` 脚本（`pnpm run build`），使 GitHub/git 安装会在安装方机器上从 `src/` 构建 `lib/`。
- `pnpm docs:check` 现在同时校验仓库根的三对双语文档：`README`、`CONTRIBUTING`、`CHANGELOG` 都必须有 `.zh.md` 副版与 `*.i18n.yaml` 一致性记录。

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

[Unreleased]: https://github.com/cherrchen/dsh-plugin-git/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/cherrchen/dsh-plugin-git/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/cherrchen/dsh-plugin-git/releases/tag/v0.1.0
