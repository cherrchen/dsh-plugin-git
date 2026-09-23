# DSH 兼容契约

- **Status**: Current

## 已验证并承诺支持的版本

唯一版本清单位于 [`src/compat/dsh-version.ts`](../../src/compat/dsh-version.ts)：

- `0.1.5-rc.2`
- `0.1.6-alpha.1`
- `0.1.6-alpha.2`
- `0.1.7-alpha.1`

每个 `@deepseek-ai/dsh-*` peer dependency 使用由清单生成的精确 OR 范围。开发依赖与提交锁文件统一 pin 到 `0.1.5-rc.2`。主 CI 使用冻结锁文件验证此开发 pin；DSH 兼容矩阵 CI 从唯一清单选取其余受支持版本，逐版本重新解析依赖并运行相同的兼容检查、测试、文档检查、构建与 artifact 检查。手动 dispatch 可将矩阵指向一个尚未承诺支持的精确 prerelease，以候选模式验证。`0.1.6-alpha.1` 是已验证版本，后续加入 alpha.2 与 0.1.7 时应保留在支持清单内；兼容代码按服务和导出结构选择旧、新接口，不按版本号分支。

跨版本适配集中在 [`src/compat/`](../../src/compat)：提交信息设置适配器在旧版 `settingsScope` 与 0.1.7 的 `configForms` 间转换表单，图标适配器在固定尺寸名称与 0.1.7 权重 glyph 间选择。开发 pin 始终保持 `0.1.5-rc.2`。

`dsh-client-ui-primitives` 的发布 bundle 导入 `diff`，但上游没有将其声明为运行时依赖。本插件将 `diff`（`>=9 <10`）声明为 peer。alpha.2 的 bundle 还导入 `simple-icons@16.31.0`，同样未声明运行时依赖；本插件将 `simple-icons`（`>=16.31.0 <17`）声明为 peer，并以 `16.31.0` 做开发依赖 pin。这样严格依赖解析器也能满足上游 bundle 的导入。

## alpha.2 接口差异评估

晋级 `0.1.6-alpha.2` 前，对比了本插件直接依赖的 alpha.1 与 alpha.2 发布 manifest 和声明文件，并用候选依赖执行构建与回归：

- `dsh-api-session-controller` 调整 Session 管理契约：列表不再暴露 `current` 选择字段，快照移除了 transient queue；选择与生命周期改由 Session 引用和状态接口表达。本插件只根据注入的 `sessionId` 通过稳定的 `useSessions(...byId[id].cwd)` 取工作目录，因此移除了对 `current` 的结构假设。
- `dsh-client-ui-settings` / `dsh-client-ui-settings-plugins` 将插件配置贡献从旧的 `settings.plugin.item` 迁到 `settings.plugins.tab`。插件仍注册旧插槽，并同时注册新的插件页标签，分别供两个受支持版本消费。
- `dsh-client-ui-slots`、`dsh-client-ui-renderer` 与 `dsh-client-ui-conversation` 增加 Factory、显式 Session scope target 等机制，且调整了多个 Conversation 插槽契约。Git 用到的 `conversation.input.left`、`sidebar.right.pane.tab`、`sidebar.right.pane.tab.title` 和这两个设置贡献的注册运行时形态可以继续工作；对设置插槽名的声明差异经小型结构接口隔离。
- `dsh-subprocess` 保留插件实际使用的 `resolveExecutable` 与 `spawn`。alpha.2 增加的 terminal activity 能力与本插件无关；右侧栏 `openTab` / `openResource` 也保留当前调用形态。

主要风险因此集中在 Client slot 消费与依赖包导入，而非 Git Host 的进程调用。候选验证首次发现 primitives bundle 新增未声明的 `simple-icons` runtime import；补齐 peer 后，alpha.2 下 Host/Client 类型构建、测试及 artifact 检查通过。

## 0.1.7-alpha.1 接口差异评估

晋级 `0.1.7-alpha.1` 前，对比了插件直接使用的上游 npm 发布包 `0.1.6-alpha.2` 与 `0.1.7-alpha.1` 的公开声明、manifest 和运行时 bundle：

- **必须适配：设置服务与配置 schema 迁移。** `dsh-client-ui-settings` 删除 `settingsScope.bind({ namespace })` 与 `SettingsScope` 类型，新增 `configForms.get(entryId)` / `ConfigForm`。Git 的提交信息设置卡片依赖旧服务进行快照订阅和 revision-fenced mutate；未适配时新的服务注入永不启动，设置卡片消失。插件现在分别注入 `settingsScope` 与 `configForms`，都接入同一个结构化卡片控制器。新 `mutate` 返回 `boolean`、旧版返回 `void`；控制器根据订阅后的快照判断写入是否落地，兼容两种结果。
- **必须适配：Host 设置由独立 section 转为插件 Config 投影。** `dsh-settings` 移除了 `installSection`，改为从插件 `Config` 的 `.volatile()` 字段生成表单，应用的插件配置引用提供实时值。提交信息配置字段现标记为 volatile，Host 配置表单自动生成关闭，Client 自有页面通过插件 entry id `@dsh-electron/dsh-plugin-git` 读取整个 Config，并将写操作映射到 `commitMessage.*` 路径。`.volatile()` 由 `@deepseek-ai/schemastery@3.18.3` 提供，因此将本包直接依赖的最低版本提高到 `3.18.3`。
- **需关注但未发现阻断：设置 UI slots 的组织方式变化。** `dsh-client-ui-settings-plugins` 从自身提供若干内置配置表单改为只提供 Settings 插件页框架；`settings.plugins.tab` 仍由 feature-owned 页签注册。Git 仍在旧 `settings.plugin.item` 与新 `settings.plugins.tab` 注册贡献，宿主只消费已知插槽。
- **需适配：primitives 图标导出重命名。** `dsh-client-ui-primitives` 将固定尺寸图标（如 `IconChevronDownOutline14`、`IconBranchOutline16`）改为带权重名的 glyph（如 `IconChevronDownOutlineMedium`）。Git 通过本地兼容层先找旧导出，再映射至新 Medium glyph；Menu API 保持可用。
- **当前调用保持兼容：Git 服务与主要 Client 扩展点。** `dsh-subprocess` 保留 `resolveExecutable` / `spawn` 声明；右侧栏插件调用的 `openTab` / `openResource` 和注册所需 SidebarRight tab/resource 类型未改变。
- **上游 bundle 漏声明运行时依赖。** `dsh-client-store@0.1.7-alpha.1` bundle 导入 `zustand` 和 `immer`，但 manifest 未声明它们；严格依赖解析器运行测试时无法解析模块。本包补充 `zustand`（`>=4.4.7 <5`）和 `immer`（`>=10.1.1 <11`）peer，并以匹配上游的开发版本验证。
- **Cordis 最低版本提高。** DSH 0.1.7-alpha.1 的直接依赖要求 Cordis `^4.0.3`；本包将 peer 下限与开发依赖同步到 4.0.3，以免宿主包树在候选版下落入不满足 peer 的 Cordis 4.0.2。
- **Session 与 LLM 风险检查：** Session Controller 重组了 subagent catalog 到 projection baseline 的接口，移除若干 catalog 专用成员；插件不调用这些接口，只按 `sessionId` 从 `useSessions(...).byId[id].cwd` 取工作目录。LLM 类型有所扩充/重排，插件依赖的 `GenerateOptions`、`Message`、`MessageId` 与 `TextBlock` 通过候选版构建验证。

候选版本的直接依赖安装后，类型构建、测试及 artifact 检查用于验证上述兼容判断。新的 `ConfigForms.get` 以宿主 entry id 作为查找键；插件通过 `@dsh-electron/dsh-plugin-git` 插件 entry id 读取 Config 表单，旧版仍使用 `git-commit-message` 独立设置 namespace。

## 静态一致性门禁

`pnpm compat:check` 在构建之前检查：

1. peer dependencies 是否与精确版本清单一致；
2. 每个 DSH peer 是否有对应开发依赖；
3. 所有 DSH 开发依赖是否 pin 在同一已支持版本；
4. 当前 `node_modules` 中每个已声明的 DSH 包是否存在且解析到该 pin。

主 CI 使用已提交锁文件中的开发 pin，冻结安装后运行兼容门禁、测试、文档检查、构建与 artifact 检查。`.github/workflows/upgrade.yml` 通过 `scripts/check-dsh-compat.mjs --list-non-default` 从唯一版本清单中动态生成非开发 pin 的矩阵，避免再复制维护版本数组；每个车道切换至对应精确版本、重新解析依赖，再运行同一组门禁。两条工作流均不会静默改变支持清单。

该检查覆盖本插件直接声明的 DSH peer 与开发依赖，不承诺整个 DSH 宿主依赖树都没有上游 peer 警告。全宿主依赖图的整合验证需由上游组合仓库负责。

## 候选版本验证与晋级

`.github/workflows/upgrade.yml` 在 PR、main 更新和每周定时执行时回归其余全部受支持版本。手动运行时可传入一个精确 prerelease 版本，以 `DSH_COMPAT_MODE=warn` 验证未列候选；候选模式不修改清单或 peer 声明。

候选车道成功是升级证据，不会自动扩大支持承诺。晋级时应审查上游接口差异与验证结果，然后更新唯一清单和 peer 范围；开发 pin 可按需调整，非默认矩阵由脚本自动随清单扩展。开发 pin 是本地和锁文件的稳定基线；主 CI 验证该 pin，升级矩阵持续回归所有其他承诺版本。

本插件使用标准 Cordis 服务、`ctx.subprocess` 和 Client 类型/服务契约，没有替换宿主 provider 或扩大权限的运行时行为，因此当前只设置仓库与 CI 兼容门禁，不在插件启动时拒绝未知宿主版本。若将来引入依赖不稳定上游内部结构或影响安全边界的行为，应重新评估运行时门禁。

## 相关决策

- [ADR-0003：以精确版本清单承诺 DSH 兼容性](../decisions/ADR-0003-dsh-compatibility-contract.md)
