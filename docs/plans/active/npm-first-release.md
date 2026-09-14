# Plan: npm 首次发布与 Release 流水线

- **Status**: In progress
- **Started**: 2026-09-13（版本重置与 release 工作流）
- **Completed**: （未完成）

## 背景

包发布到 npm 为 `@dsh-electron/dsh-plugin-git`（`publishConfig.access` = `public`）；根 README [npm publication](../../../README.md#npm-publication) 当前仍声明"尚未发布，API 与版本按 pre-release 对待"。发布前状态：

- Release 已由 tag 触发的 `.github/workflows/release.yml` 承担：校验 tag 与版本一致 → 测试 → `docs:check` → 构建 → 产物断言 → `pnpm pack` → 创建 GitHub Release；
- 2026-09-14 决策：DeepSeek Harness Desktop 后续**直接消费本仓库发布的 npm 包**，不再把本仓库 subtree 镜像进 `cherrchen/deepseek-harness-electron`（见 [branch-and-mirror-layout](../../../.agent/note/branch-and-mirror-layout.md)）——npm 首发因此成为该集成的唯一前置；
- 包从未发布到 npm：npm 上不存在该包，也就无法绑定 Trusted Publisher；
- 2026-09-13 的首次 tag 试运行中 npm publish 因缺 `NPM_TOKEN` 失败，该步骤当时被整体移除；2026-09-14 重新加入，并改为 token/OIDC 双模式（本计划当前形态）；
- 版本脚本统一为 `pnpm version:set`，2026-09-14 增加 `version:major|minor|patch` 快捷脚本并把版本提升到 `0.2.0`。

## 目标

1. tag 推送后自动发布 `@dsh-electron/dsh-plugin-git` 到 npm，并与 GitHub Release 双渠道一致；
2. **首发用仓库 secret `NPM_TOKEN`**（包尚不存在，Trusted Publisher 无从绑定）；
3. **后续版本切到 OIDC trusted publishing**：绑定 Trusted Publisher 并删除 `NPM_TOKEN`，工作流不改一行即自动切换；
4. 两种模式都产出 npm provenance。

## 非目标

- 改动包运行时行为；发布流水线只验证并分发既有构建产物。
- dist-tag 策略与回滚流程（npm 版本不可撤销，只能发新版本号）。
- Desktop 侧改为消费 npm 版本的落地改动（Desktop 仓库自身的工作；本计划只负责把包发上 npm，背景见 [branch-and-mirror-layout](../../../.agent/note/branch-and-mirror-layout.md)）。

## 方案

`v*` tag 触发 `.github/workflows/release.yml` 单 job：版本一致性校验 → `pnpm install --frozen-lockfile` → `pnpm test` → `pnpm docs:check` → `pnpm build` → `pnpm test:artifact` → `pnpm pack --pack-destination dist` → npm publish → `gh release create`（附同一个 tarball）。

npm 认证集中在 "Publish to npm" 一步内自动二选一，无需后续改工作流：

- `secrets.NPM_TOKEN` 非空 → 写入 `$RUNNER_TEMP` 下的临时 npmrc（`//registry.npmjs.org/:_authToken=…`）后 `npm publish --access public --provenance`；
- 为空 → 直接 `npm publish`，由 `id-token: write` 触发 trusted publishing（OIDC）。

运行日志用 `::notice title=npm auth::` 标注实际模式。工作流显式安装 npm `>=11.5.1`：Node 22.x 自带的 npm 10 不支持 trusted publishing。

### 依赖与前置

- 维护者需创建 **Automation token**（publish 权限）并配置为仓库 secret `NPM_TOKEN`：npmjs.com → Access Tokens → Generate New Token → Automation；GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret。secret 缺失且未绑定 Trusted Publisher 时，publish 步会走 OIDC 分支并以认证失败报错，这是预期的第一步失败点。
- 首发成功后，在该包的 npm 设置里绑定 Trusted Publisher：repository `cherrchen/dsh-plugin-git`、workflow filename `release.yml`；随后删除 `NPM_TOKEN`。

## 任务清单

- [x] 新增 `version:set` 与 `version:major|minor|patch` 脚本，版本提升到 `0.2.0`（2026-09-14）
- [x] Release 工作流加入 npm publish（token/OIDC 双模式 + provenance）
- [x] 文档：[development](../../development/README.md) 记录发布流程与两阶段认证
- [ ] 配置仓库 secret `NPM_TOKEN`
- [ ] 推送 `v0.2.0` tag 完成 npm 首发（token 模式）
- [ ] 首发后在 npmjs.com 绑定 Trusted Publisher 并删除 `NPM_TOKEN`（后续走 OIDC）
- [ ] 更新根 README [npm publication](../../../README.md#npm-publication)（发布后不再是"尚未发布"；同步 `README.zh.md` 与 `README.i18n.yaml` 的 sha）
- [ ] 核对 npm 与 GitHub Release 双渠道一致

## 验证

- 推送 `v0.2.0` 后 Actions 全绿，日志中 `::notice title=npm auth::` 标明 token 模式；
- `npm view @dsh-electron/dsh-plugin-git@0.2.0` 可见，且 npm 页面显示 provenance；
- GitHub Release 附 `dsh-electron-dsh-plugin-git-0.2.0.tgz`；
- 删除 `NPM_TOKEN` 后再发一个版本，日志显示 OIDC 模式且发布成功；
- `dsh plugin --profile web add` 能从 npm 安装本包（替代目前的仓库/fixture 安装方式，见根 README [Installation](../../../README.md#installation)）。

## 相关文档

- [requirements/scope-and-requirements](../../requirements/scope-and-requirements.md)（NFR-3 可独立安装与发布）
- [development](../../development/README.md)（构建、测试命令与发布流程）
