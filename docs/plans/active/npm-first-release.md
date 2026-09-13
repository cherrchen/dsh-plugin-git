# Plan: npm 首次发布与 Release 流水线

- **Status**: In progress
- **Started**: 2026-09-13（版本重置与 release 工作流草稿）
- **Completed**: （未完成）

## 背景

包要发布到 npm 为 `@dsh-electron/dsh-plugin-git`（根 README [npm publication](../../../README.md#npm-publication) 一节声明"发布尚不可用，API 与版本按 pre-release 对待"）。当前处于发布准备阶段：

- 版本已重置为 `0.1.0`，新增 `pnpm version:set` 脚本统一改版（提交 `08b693b`）；
- 新增 tag 触发的 Release 工作流 `.github/workflows/release.yml`（**尚未提交入库**，工作区未跟踪状态）；
- `publishConfig.access` 已设为 `public`。

## 目标

1. `vX.Y.Z` tag 推送后自动：校验 tag 与 `package.json` 版本一致 → 安装（frozen lockfile）→ `pnpm test` → `pnpm build` → `pnpm test:artifact` → `pnpm pack` → `pnpm publish --access public` → 创建 GitHub Release 并附 tarball。
2. 发布渠道可用：npm token（`NPM_TOKEN` secret）配置完成。
3. 首个正式版本 tag 发布成功。

## 非目标

- 改动包运行时行为；发布流水线只验证并分发既有构建产物。
- 解决 Details Host 的 npm 发布（它是独立包，本包发布前它必须已可用，见 [ADR 依赖关系](#依赖与前置)）。

## 方案

Release 全部由 GitHub Actions 完成（`.github/workflows/release.yml`）：tag 触发，单 job 顺序执行测试、构建、打包、发布、GitHub Release。版本一致性用脚本前置校验，失败即终止，避免错版发布。

### 依赖与前置

- `NPM_TOKEN` secret 已配置到仓库；
- `@dsh-electron/dsh-client-ui-details-host` 在 npm 可安装（peerDependencies 要求 `>=0.3.0 <0.4.0`）——当前它也未上 npm，是本计划的**前置阻塞项**（相关背景见 [`.agent/note/branch-and-mirror-layout.md`](../../../.agent/note/branch-and-mirror-layout.md)）。

## 任务清单

- [x] 新增 `version:set` 脚本并重置版本为 `0.1.0`
- [x] 编写 tag 触发的 Release 工作流（本地草稿，待提交）
- [ ] 提交 `release.yml` 入库并通过 CI 验证
- [ ] 配置 npm 发布凭据（`NPM_TOKEN`）
- [ ] Details Host 包发布到 npm（前置，属另一包的对应计划）
- [ ] 试运行：pre-release tag（如 `v0.1.0`）走完全流程
- [ ] 首个正式 tag 发布并核对 npm 与 GitHub Release

## 验证

- 推送测试 tag 后：Actions 全绿；npm 上出现对应版本；GitHub Release 附带 tarball；
- `dsh plugin --profile web add` 能从 npm 安装本包（替代目前的仓库/fixture 安装方式，见根 README [Installation](../../../README.md#installation)）。

## 相关文档

- [requirements/scope-and-requirements](../../requirements/scope-and-requirements.md)（NFR-3 可独立安装与发布）
- [development](../../development/README.md)（构建、测试命令）
