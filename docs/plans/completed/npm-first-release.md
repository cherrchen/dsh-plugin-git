# Plan: npm 首次发布与 Release 流水线

- **Status**: Completed
- **Started**: 2026-09-13（版本重置与 release 工作流）
- **Completed**: 2026-09-14（`v0.2.1` 为首个 OIDC 发布；npm 安装路径已在隔离 profile 实测）

## 背景

包发布到 npm 为 `@dsh-electron/dsh-plugin-git`（`publishConfig.access` = `public`）。**首发已于 2026-09-14 完成**：`0.2.0` 以 token 模式发布，npm 与 GitHub Release 双渠道一致，根 README 已同步为"已发布"。起点状态：

- Release 已由 tag 触发的 `.github/workflows/release.yml` 承担：校验 tag 与版本一致 → 测试 → `docs:check` → 构建 → 产物断言 → `pnpm pack` → npm publish → 创建 GitHub Release；
- 2026-09-14 第二个版本 `0.2.1` 沿用同一条流水线发布，且是**首个 OIDC 发布**：`NPM_TOKEN` 已删除、Trusted Publisher 已绑定，工作流未改一行即切到 OIDC；
- 2026-09-14 决策：DeepSeek Harness Desktop 后续**直接消费本仓库发布的 npm 包**，不再把本仓库 subtree 镜像进 `cherrchen/deepseek-harness-electron`（见 [branch-and-mirror-layout](../../../.agent/note/branch-and-mirror-layout.md)）——npm 首发因此是该集成的唯一前置；
- 包此前从未发布到 npm，npm 上不存在该包，因此首发只能用 token（Trusted Publisher 无从绑定）；
- 2026-09-13 的首次 tag 试运行中 npm publish 因缺 `NPM_TOKEN` 失败，该步骤当时被整体移除；2026-09-14 重新加入并改为 token/OIDC 双模式；
- 2026-09-14 首发首次触发也失败：`npm publish dist/….tgz` 被 npm 解析成 GitHub `owner/repo` 简写（`git ls-remote ssh://git@github.com/dist/….tgz.git`，exit 128）。修复为带 `./` 前缀的文件路径后平移 `v0.2.0` tag 重跑成功（当时 npm 上无 0.2.0、GitHub Release 未创建，平移安全）；
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
- [x] 修复 tarball 参数被 npm 当作 GitHub 简写的问题（`./` 前缀），平移 `v0.2.0` tag 后重跑成功
- [x] 配置仓库 secret `NPM_TOKEN`
- [x] 推送 `v0.2.0` tag 完成 npm 首发（token 模式，2026-09-14 06:36 UTC）
- [x] 更新根 README [npm publication](../../../README.md#npm-publication)（含 `README.zh.md` 与 `README.i18n.yaml` 的 sha）
- [x] 核对 npm 与 GitHub Release 双渠道一致
- [x] 首发后在 npmjs.com 绑定 Trusted Publisher 并删除 `NPM_TOKEN`（后续走 OIDC）
- [x] 推送 `v0.2.1` 完成首个 OIDC 发布（2026-09-14 13:16 UTC，run `34848173089`）
- [x] 在隔离 `DSH_HOME` 用真实 CLI 验证 `dsh plugin --profile web add @dsh-electron/dsh-plugin-git@0.2.1` 可从 npm 安装并进入组合

## 验证

已完成（2026-09-14）：

- `v0.2.0`（token 模式，run `34814144100`）：Release run 全绿，日志 `::notice title=npm auth::Publishing with the NPM_TOKEN secret.`；npm 上 `@dsh-electron/dsh-plugin-git@0.2.0` 为 `latest`，`dist.attestations.provenance` 为 SLSA v1；GitHub Release `v0.2.0` 附 `dsh-electron-dsh-plugin-git-0.2.0.tgz`；
- `v0.2.1`（首个 OIDC 发布，run `34848173089`）：Release run 全绿，日志 `No NPM_TOKEN secret; publishing with npm trusted publishing (OIDC).`；publish 输出 `+ @dsh-electron/dsh-plugin-git@0.2.1` 与 provenance 语句（transparency log index `2831155581`）；registry 元数据 `dist-tags.latest = 0.2.1`，`dist.attestations.provenance.predicateType` = `https://slsa.dev/provenance/v1`；GitHub Release `v0.2.1` 附 `dsh-electron-dsh-plugin-git-0.2.1.tgz`；
- 根 README（en/zh）与已发布状态一致，`pnpm docs:check` 通过。

npm 安装路径（2026-09-14，隔离 `$DSH_HOME`，CLI `@deepseek-ai/dsh@0.1.5-rc.2`）：

```sh
dsh plugin --profile web install
dsh plugin --profile web add @dsh-electron/dsh-plugin-git@0.2.1
dsh --profile web --dump-config
```

- `add` 从 registry 装成 `0.2.1`，并把 `@dsh-electron/dsh-plugin-git` 回填进该 profile 的 `dsh.profile.bundles`；
- `--dump-config` 合成出 `id: dsh-plugin-git` 行，stderr 无 patch 未匹配告警；
- 安装形态的包内含 `cordis.patch.yml`、`lib/index.js`、`lib/client.js` 与 `lib/types/**`，与 `files` 白名单一致。

## 相关文档

- [requirements/scope-and-requirements](../../requirements/scope-and-requirements.md)（NFR-3 可独立安装与发布）
- [development](../../development/README.md)（构建、测试命令与发布流程）
