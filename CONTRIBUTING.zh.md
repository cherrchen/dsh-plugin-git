# 贡献指南

[English](CONTRIBUTING.md) | 中文

感谢参与 `@dsh-electron/dsh-plugin-git` —— 本仓库是 npm 包 `@dsh-electron/dsh-plugin-git` 的 canonical 来源，它以 out-of-tree bundle 的形式为 DeepSeek Harness 增加 Git repository 操作与 Client UI。欢迎提交 Issue 与 pull request。

## 动手之前

以下文档是本仓库实际执行的规则：

| 文档 | 它拥有的内容 |
| --- | --- |
| [`AGENTS.md`](AGENTS.md) | 包边界：只用标准 DSH service、以独立 argv values 调用 `ctx.subprocess`、禁止 shell 插值、Host 核心不得 import Electron、所有 portable Client 贡献都在 main fiber |
| [`docs/README.md`](docs/README.md) | 正式文档库、其目录划分与边界 |
| [`.agent/skills/documentation/SKILL.md`](.agent/skills/documentation/SKILL.md) | 文档维护规则：双语配对、ADR、Plan 生命周期、链接与命名纪律 |
| [`docs/development/README.md`](docs/development/README.md) | 工具链、命令、构建链路与发布流程 |

本包处于 pre-1.0：API 与版本在 minor 版本之间可能变化。Client 半部要求 DeepSeek Harness ≥ v0.1.5-rc.2，因为它经上游右侧边栏注册 tab type。

## 环境

- Node.js `^22.19.0 || >=24.0.0` 与 pnpm 11（版本由 `packageManager` 钉定）；
- `PATH` 中有 `git` —— Host service 运行的是真实的 Git 可执行文件；
- 手动验证 Client 半部时，需要一个 DeepSeek Harness ≥ v0.1.5-rc.2 运行时及其 `dsh` CLI。

```sh
git clone https://github.com/cherrchen/dsh-plugin-git.git
cd dsh-plugin-git
pnpm install --frozen-lockfile
pnpm test
pnpm build
```

`prepare` 即 `pnpm run build`，因此 git 方式安装本包时由 pnpm 在安装方机器上现场构建：`tsc` 产出 `lib/types/**` 声明，随后 `tsdown` 打包出 `lib/index.js` 与 `lib/client.js`。`lib/` 不在 Git 中 —— 请在自己的 checkout 里运行 `pnpm build`，改动源码后重建（制品规格读的是它）。

## 工作流

1. 从 `main` 拉分支（`fix/git-rpc-channel`、`feat/diff-tab`、`docs/installation` 等）。
2. 改动保持外科手术式，不要重排无关代码的格式。
3. 提交信息采用带 scope 的 conventional commits，与既有历史一致：`feat(client): …`、`fix(host): …`、`fix(git-graph): …`、`docs: …`、`test: …`、`chore(deps): …`。
4. 运行下面的门禁；CI 以同样顺序运行同一批命令。

## 质量门禁

`.github/workflows/ci.yml` 对每个 pull request 与每次 `main` push 先执行 `pnpm install --frozen-lockfile`，再按此顺序执行：

| 命令 | 它证明什么 |
| --- | --- |
| `pnpm test` | Host 与 Client 规格：vitest；组件用 jsdom + `@testing-library/react` |
| `pnpm docs:check` | 文档结构：双语配对、链接目标、文件命名、绝对路径禁令 |
| `pnpm build` | 类型声明与两个 bundle 面 |
| `pnpm test:artifact` | 构建出的 Client bundle 及其 manifest |
| `pnpm pack` | tarball 内容与 `package.json` 的声明一致 |

测试读取机器可读的 Git 输出并使用临时仓库，既不依赖网络，也不需要模型凭据。

## 文档义务

文档是变更的一部分，不是后续任务：

- 变更触及需求、架构、公共接口、配置、工作流、构建或发布行为、模块边界、排错知识时，**在同一变更内**更新 `docs/` 下的 canonical 文档；只有在没有文档拥有该事实时才新建文档；
- 同一变更内保持双语配对同步（`README.md`/`README.zh.md`、`CONTRIBUTING.md`/`CONTRIBUTING.zh.md`、`CHANGELOG.md`/`CHANGELOG.zh.md`、`docs/*/README.md`/`README.en.md`），然后在对应的 `*.i18n.yaml` 中重新登记双方的 blob hash：

  ```sh
  git hash-object README.md README.zh.md             # → README.i18n.yaml
  git hash-object CONTRIBUTING.md CONTRIBUTING.zh.md # → CONTRIBUTING.i18n.yaml
  git hash-object CHANGELOG.md CHANGELOG.zh.md       # → CHANGELOG.i18n.yaml
  ```

- 真实存在多种合理方案、且有长期成本的决策写成 ADR，放在 `docs/decisions/`（模板：[`.agent/templates/adr.md`](.agent/templates/adr.md)）；完成的计划从 `docs/plans/active/` 移入 `docs/plans/completed/`；
- 在同一 pull request 中把变更的用户可见效果写入 [`CHANGELOG.md`](CHANGELOG.md) 的 `## [Unreleased]` 一节；发布提交再把它移到新版本号之下。

## 代码规则

- 以 executable 加独立 argv values 通过 `ctx.subprocess` 启动 Git；绝不拼接命令字符串，并让每个 caller-supplied path、branch 与 message 始终是一个 argv value；
- Host 核心只依赖标准 DSH service：不得在其中 import Electron、preload 全局变量或 Desktop provider；
- 所有 portable Client 贡献都留在 main fiber；native enhancement 属于 `ctx.inject(['desktop'], ...)` child fiber，且只声明它实际消费的结构化方法；
- 本包必须保持可独立安装、可独立发布：依赖一律 registry semver，禁止 `workspace:`；
- 在另有决策之前，GitHub 与远端凭据工作流不属于本 package。

## 发布

只有维护者执行发布。流程见 [`docs/development/README.md`](docs/development/README.md#release-process)：用 `pnpm version:*` 提升版本、提交、推送 `vX.Y.Z` tag，release 工作流随后把 tarball 发布到 npm 并创建对应的 GitHub Release。
