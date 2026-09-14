中文 | [English](README.en.md)

# development/ —— 工程实践

收录**如何开发、测试、构建与发布本包**：环境、工作流、测试约定、构建链路与发布流程。

- 收：工具链版本、常用命令、测试与 fixture 约定、CI/CD 说明、发布流程。
- 不收：包的运行时行为与配置（→ 根 `README.md`）、架构设计（→ [`../architecture/`](../architecture/README.md)）、发布计划的执行状态（→ [`../plans/active/`](../plans/active/README.md)）。

## 快速入口

工具链：Node.js `^22.19.0 || >=24.0.0`，pnpm 11（`packageManager` 钉定）。

`prepare` 脚本即 `pnpm run build`（`tsc` 声明 + 两个 bundle 面）：git 方式安装本包时由 pnpm 在安装方现场执行它；本仓库 checkout 内请显式运行 `pnpm build`。

| 目的 | 命令 |
| --- | --- |
| 安装（锁文件严格模式） | `pnpm install --frozen-lockfile` |
| 全量测试 | `pnpm test` |
| 构建产物 bundle/manifest 断言 | `pnpm test:artifact` |
| 构建（类型 + bundle） | `pnpm build` |
| 文档机器校验 | `pnpm docs:check` |
| 设置版本号 | `pnpm version:set <version>`（也接受 `major`/`minor`/`patch` 等 bump 关键字） |
| 提升版本号 | `pnpm version:major` / `pnpm version:minor` / `pnpm version:patch` |

CI 在 `.github/workflows/ci.yml`（PR 与 main push 跑测试），发布流水线见下节，执行状态见 [npm-first-release 计划](../plans/active/npm-first-release.md)。贡献者的环境搭建、门禁清单与文档义务见 [`CONTRIBUTING.md`](../../CONTRIBUTING.md)。

## 发布流程

版本号只经 `pnpm version:*` 改动：这些脚本带 `--no-git-tag-version --no-git-checks`，**不**自动提交、也不打 tag。

```sh
# 1. 把 CHANGELOG.md 的 Unreleased 条目移到新版本号之下，同步 CHANGELOG.zh.md，
#    并在 CHANGELOG.i18n.yaml 中重新登记双方 sha
pnpm version:patch   # 或 version:set <version> / version:major / version:minor
git add package.json CHANGELOG.md CHANGELOG.zh.md CHANGELOG.i18n.yaml \
  README.md README.zh.md README.i18n.yaml
git commit -m "chore(release): 0.2.1"
git tag v0.2.1
git push origin HEAD --follow-tags
```

发布提交同时负责把 [`CHANGELOG.md`](../../CHANGELOG.md) 的 `[Unreleased]` 条目落到新版本号之下，并把 `[Unreleased]` 的比较链接指向该 tag；当 [`README.md`](../../README.md) 安装一节中出现版本号时，同一个提交负责同步它并重新登记 `README.i18n.yaml`。

tag 必须是 `v` + `package.json` 的版本，否则工作流在第一步就终止。`.github/workflows/release.yml` 由 `v*` tag 推送触发，单 job 顺序执行：

1. 校验 tag 与 `package.json` 版本一致；
2. `pnpm install --frozen-lockfile` → `pnpm test` → `pnpm docs:check` → `pnpm build` → `pnpm test:artifact`；
3. `pnpm pack --pack-destination dist` 产出唯一 tarball；
4. `npm publish <tarball> --access public --provenance` 发布到 npm；
5. `gh release create --verify-tag --generate-notes`，GitHub Release 附同一个 tarball。

### npm 认证：token 首发 → OIDC 常态

npm 的 Trusted Publisher 只能在包已存在后绑定，因此首发用 token、后续走 OIDC。工作流同一步骤按 secret 是否存在自动二选一，无需改工作流：

| 阶段 | 认证 | 前置 |
| --- | --- | --- |
| 首发 | 仓库 secret `NPM_TOKEN`（Automation token，publish 权限）写入 `$RUNNER_TEMP` 下的临时 npmrc | 包在 npm 上尚不存在，无法绑定 Trusted Publisher |
| 之后 | OIDC trusted publishing（`id-token: write`，无长期凭据） | 在 npmjs.com 为该包绑定 Trusted Publisher（仓库 `cherrchen/dsh-plugin-git` + workflow 文件名 `release.yml`），随后删除 `NPM_TOKEN` |

- 工作流显式安装 npm `>=11.5.1`：Node 22.x 自带的 npm 10 不支持 trusted publishing；
- 两种模式都带 `--provenance`（公开仓库 + `id-token: write`），发布记录可校验来源；
- 运行日志中的 `::notice title=npm auth::` 标注本次实际使用的模式；
- 失败重跑：在 Actions 里重新运行该 tag 的工作流；npm 同版本不可重复发布（E403），已发版本只能靠新版本号推进。

测试约定：使用机器可读 Git 输出与临时仓库；客户端规格用 jsdom + `@testing-library/react`；Graph 布局的 fixtures 与不变量见 [`../reference/git-graph-layout.md`](../reference/git-graph-layout.md#测试与-invariants)。
