# DSH 兼容契约

- **Status**: Current

## 已验证并承诺支持的版本

唯一版本清单位于 [`src/compat/dsh-version.ts`](../../src/compat/dsh-version.ts)：

- `0.1.5-rc.2`
- `0.1.6-alpha.2`

每个 `@deepseek-ai/dsh-*` peer dependency 使用由清单生成的精确 OR 范围。开发依赖与提交锁文件统一 pin 到 `0.1.5-rc.2`；主 CI 以兼容矩阵分别验证清单中的每个版本。矩阵的非默认车道从冻结安装开始，再使用候选升级脚本切换开发依赖并重新解析锁文件。

`dsh-client-ui-primitives` 的发布 bundle 导入 `diff`，但上游没有将其声明为运行时依赖。本插件将 `diff`（`>=9 <10`）声明为 peer。alpha.2 的 bundle 还导入 `simple-icons@16.31.0`，同样未声明运行时依赖；本插件将 `simple-icons`（`>=16.31.0 <17`）声明为 peer，并以 `16.31.0` 做开发依赖 pin。这样严格依赖解析器也能满足上游 bundle 的导入。

## alpha.2 接口差异评估

晋级 `0.1.6-alpha.2` 前，对比了本插件直接依赖的 alpha.1 与 alpha.2 发布 manifest 和声明文件，并用候选依赖执行构建与回归：

- `dsh-api-session-controller` 调整 Session 管理契约：列表不再暴露 `current` 选择字段，快照移除了 transient queue；选择与生命周期改由 Session 引用和状态接口表达。本插件只根据注入的 `sessionId` 通过稳定的 `useSessions(...byId[id].cwd)` 取工作目录，因此移除了对 `current` 的结构假设。
- `dsh-client-ui-settings` / `dsh-client-ui-settings-plugins` 将插件配置贡献从旧的 `settings.plugin.item` 迁到 `settings.plugins.tab`。插件仍注册旧插槽，并同时注册新的插件页标签，分别供两个受支持版本消费。
- `dsh-client-ui-slots`、`dsh-client-ui-renderer` 与 `dsh-client-ui-conversation` 增加 Factory、显式 Session scope target 等机制，且调整了多个 Conversation 插槽契约。Git 用到的 `conversation.input.left`、`sidebar.right.pane.tab`、`sidebar.right.pane.tab.title` 和这两个设置贡献的注册运行时形态可以继续工作；对设置插槽名的声明差异经小型结构接口隔离。
- `dsh-subprocess` 保留插件实际使用的 `resolveExecutable` 与 `spawn`。alpha.2 增加的 terminal activity 能力与本插件无关；右侧栏 `openTab` / `openResource` 也保留当前调用形态。

主要风险因此集中在 Client slot 消费与依赖包导入，而非 Git Host 的进程调用。候选验证首次发现 primitives bundle 新增未声明的 `simple-icons` runtime import；补齐 peer 后，alpha.2 下 Host/Client 类型构建、测试及 artifact 检查通过。

## 静态一致性门禁

`pnpm compat:check` 在构建之前检查：

1. peer dependencies 是否与精确版本清单一致；
2. 每个 DSH peer 是否有对应开发依赖；
3. 所有 DSH 开发依赖是否 pin 在同一已支持版本；
4. 当前 `node_modules` 中每个已声明的 DSH 包是否存在且解析到该 pin。

主 CI 的矩阵数组由 `.github/workflows/ci.yml` 在运行时通过 `scripts/check-dsh-compat.mjs --list` 从唯一版本清单生成，不另行维护版本副本。每个矩阵车道都在测试与构建前运行此门禁。默认车道的锁文件由 `pnpm install --frozen-lockfile` 验证；其他车道先应用矩阵版本，再由脚本检查实际解析版本。

该检查覆盖本插件直接声明的 DSH peer 与开发依赖，不承诺整个 DSH 宿主依赖树都没有上游 peer 警告。全宿主依赖图的整合验证需由上游组合仓库负责。

## 候选版本验证与晋级

手动运行 `.github/workflows/upgrade.yml` 并提供一个精确 prerelease 版本。候选车道把所有 DSH 开发依赖统一切换到该版本，然后运行兼容检查、测试、文档检查、构建和 artifact 检查。`DSH_COMPAT_MODE=warn` 只允许此车道验证未列版本；它不修改清单或 peer 声明。

候选车道成功是升级证据，不会自动扩大支持承诺。晋级时应人工审查差异，然后更新唯一清单、peer 范围、开发 pin 与主 CI 矩阵，并在所有矩阵车道验证。开发 pin 是本地和锁文件的稳定基线；主 CI 矩阵持续回归全部承诺版本。

本插件使用标准 Cordis 服务、`ctx.subprocess` 和 Client 类型/服务契约，没有替换宿主 provider 或扩大权限的运行时行为，因此当前只设置仓库与 CI 兼容门禁，不在插件启动时拒绝未知宿主版本。若将来引入依赖不稳定上游内部结构或影响安全边界的行为，应重新评估运行时门禁。

## 相关决策

- [ADR-0003：以精确版本清单承诺 DSH 兼容性](../decisions/ADR-0003-dsh-compatibility-contract.md)
