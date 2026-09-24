# DSH 兼容契约

- **Status**: Current

## 适配波次状态

自 `dsh-v0.1.5-rc.2` 至 `dsh-v0.1.7-rc.1` 的兼容晋级已于 **2026-09-24** 完成。清单内六个精确 prerelease 均已写入 [`src/compat/dsh-version.ts`](../../src/compat/dsh-version.ts)，`pnpm compat:check` 与升级 CI 矩阵覆盖除开发 pin 外的全部非默认版本。跨版本行为由 [`src/compat/`](../../src/compat) 内的结构探测承担；下文各节保留晋级时的接口差异评估记录。

## 已验证并承诺支持的版本

唯一版本清单位于 [`src/compat/dsh-version.ts`](../../src/compat/dsh-version.ts)：

- `0.1.5-rc.2`
- `0.1.6-alpha.1`
- `0.1.6-alpha.2`
- `0.1.7-alpha.1`
- `0.1.7-alpha.2`
- `0.1.7-rc.1`

每个 `@deepseek-ai/dsh-*` peer dependency 使用由清单生成的精确 OR 范围。开发依赖与提交锁文件统一 pin 到 `0.1.5-rc.2`。主 CI 使用冻结锁文件验证此开发 pin；DSH 兼容矩阵 CI 从唯一清单选取其余受支持版本，逐版本重新解析依赖并运行相同的兼容检查、测试、文档检查、构建与 artifact 检查。手动 dispatch 可将矩阵指向一个尚未承诺支持的精确 prerelease，以候选模式验证。清单按晋级顺序累加，已承诺版本不会被后续晋级移除；兼容代码按服务和导出结构选择旧、新接口，不按版本号分支。

跨版本适配集中在 [`src/compat/`](../../src/compat)，并且只按结构探测、不按版本号分支：提交信息设置适配器在旧版 `settingsScope` 与 0.1.7 的 `configForms` 间转换表单，并同时注册 `settings.plugin.item` 与 `plugins.bundle.config`，由宿主声明的 slot 决定哪一面出现；图标适配器在固定尺寸名称与 0.1.7 权重 glyph 间选择；schema 适配器仅在当前 schemastery 副本提供 `volatile` 时才标记字段。开发 pin 始终保持 `0.1.5-rc.2`，其宿主运行时是 Cordis `4.0.2` 与 schemastery `3.18.2`。0.1.7-alpha.1 的宿主是 Cordis `4.0.3` 与 schemastery `3.18.3`；0.1.7-alpha.2 与 0.1.7-rc.1 的宿主是 Cordis `4.0.4` 与 schemastery `3.18.4`。后两个发行版把这两份依赖写成波浪号，矩阵车道钉的是该范围的精确下限。

`dsh-client-ui-primitives` 的发布 bundle 导入 `diff`，但上游没有将其声明为运行时依赖。本插件将 `diff`（`>=9 <10`）声明为 peer。alpha.2 的 bundle 还导入 `simple-icons@16.31.0`，同样未声明运行时依赖；本插件将 `simple-icons`（`>=16.31.0 <17`）声明为 peer，并以 `16.31.0` 做开发依赖 pin。这样严格依赖解析器也能满足上游 bundle 的导入。

## alpha.2 接口差异评估

晋级 `0.1.6-alpha.2` 前，对比了本插件直接依赖的 alpha.1 与 alpha.2 发布 manifest 和声明文件，并用候选依赖执行构建与回归：

- `dsh-api-session-controller` 调整 Session 管理契约：列表不再暴露 `current` 选择字段，快照移除了 transient queue；选择与生命周期改由 Session 引用和状态接口表达。本插件只根据注入的 `sessionId` 通过稳定的 `useSessions(...byId[id].cwd)` 取工作目录，因此移除了对 `current` 的结构假设。
- `dsh-client-ui-settings` / `dsh-client-ui-settings-plugins` 从 `0.1.6-alpha.2` 起退役 `settings.plugin.item`。该插槽在 `0.1.5-rc.2` 与 `0.1.6-alpha.1` 仍由「插件」分区的 `configurable` 标签页声明。新宿主把社区插件配置放到插件管理页的 `plugins.bundle.config`，键为包名 `@dsh-electron/dsh-plugin-git`，表单出现在该组合包详情页的描述与组件列表之间。`settings.plugins.tab` 只剩功能标签外壳，不是 Git 的配置入口。适配层在 [`src/compat/dsh-client-settings.ts`](../../src/compat/dsh-client-settings.ts) 同时注册两个 slot；宿主没声明的那个保持挂起，因此六条已声明版本各自只显示自己拥有的一面。
- `dsh-client-ui-slots`、`dsh-client-ui-renderer` 与 `dsh-client-ui-conversation` 增加 Factory、显式 Session scope target 等机制，且调整了多个 Conversation 插槽契约。Git 用到的 `conversation.input.left`、`sidebar.right.pane.tab`、`sidebar.right.pane.tab.title` 和这两个设置贡献的注册运行时形态可以继续工作；对设置插槽名的声明差异经小型结构接口隔离。
- `dsh-subprocess` 保留插件实际使用的 `resolveExecutable` 与 `spawn`。alpha.2 增加的 terminal activity 能力与本插件无关；右侧栏 `openTab` / `openResource` 也保留当前调用形态。

主要风险因此集中在 Client slot 消费与依赖包导入，而非 Git Host 的进程调用。候选验证首次发现 primitives bundle 新增未声明的 `simple-icons` runtime import；补齐 peer 后，alpha.2 下 Host/Client 类型构建、测试及 artifact 检查通过。

## 0.1.7-alpha.1 接口差异评估

晋级 `0.1.7-alpha.1` 前，对比了插件直接使用的上游 npm 发布包 `0.1.6-alpha.2` 与 `0.1.7-alpha.1` 的公开声明、manifest 和运行时 bundle：

- **必须适配：设置服务与配置 schema 迁移。** `dsh-client-ui-settings` 删除 `settingsScope.bind({ namespace })` 与 `SettingsScope` 类型，新增 `configForms.get(entryId)` / `ConfigForm`。Git 的提交信息设置卡片依赖旧服务进行快照订阅和 revision-fenced mutate；未适配时新的服务注入永不启动，设置卡片消失。插件现在分别注入 `settingsScope` 与 `configForms`，都接入同一个结构化卡片控制器。新 `mutate` 返回 `boolean`、旧版返回 `void`；控制器根据订阅后的快照判断写入是否落地，兼容两种结果。
- **必须适配：Host 设置由独立 section 转为插件 Config 投影。** `dsh-settings` 移除了 `installSection`，改为从插件 `Config` 的 `.volatile()` 字段生成表单，应用的插件配置引用提供实时值。0.1.7 的提交信息配置字段需要 `volatile`，Host 配置表单自动生成关闭，Client 自有页面通过补丁行 id `dsh-plugin-git`（Loader 条目的 `options.id`）读取整个 Config，并将写操作映射到 `commitMessage.*` 路径。插件管理页的 `plugins.bundle.config` 键仍是包名 `@dsh-electron/dsh-plugin-git`，两者不是同一个字符串。`.volatile()` 从 schemastery `3.18.3`（0.1.7-alpha.1）起提供，`3.18.4`（0.1.7-alpha.2 与 0.1.7-rc.1）同样提供。0.1.5-rc.2、0.1.6-alpha.1 与 0.1.6-alpha.2 的宿主解析到 schemastery `3.18.2`，模块求值期无条件调用 `.volatile()` 会抛出 `volatile is not a function`，插件入口无法加载。适配层先探测该方法是否存在：没有就保持普通字段，旧版仍走 `installSection`。本包对 schemastery 的依赖范围是 `>=3.18.2 <4`，两个宿主副本都满足。
- **必须适配：volatile 字段的运行时值是稳定引用。** schemastery 3.18.3 把 `.volatile()` 字段解析成带 `get()` 的引用；字段缺省时引用仍然存在，`get()` 才返回 `undefined`。提交信息生成若把 `systemPrompt` 当成字符串调用 `trim`，会抛出 `prompt.trim is not a function`。`mode`、`provider`、`model` 与 `maxDiffBytes` 同样是引用，直接传给 LLM 或字节上限会读到对象。读取端用 `Symbol.for('cosmokit.volatile.write')` 识别引用并在每次生成时取 `get()` 快照，因此设置页的修改下一次生成就能生效；旧宿主的普通字符串和数字原样返回。
- **设置 UI 的配置面。** `dsh-client-ui-settings-plugins` 只提供 Settings 插件页框架；`settings.plugins.tab` 留给功能标签。Git 不注册该标签。社区插件配置走 `plugins.bundle.config`，官方宿主平面插件才使用 `plugins.item`。读写仍由 `settingsScope` 或 `configForms` 探测承担。
- **需适配：primitives 图标导出重命名。** `dsh-client-ui-primitives` 将固定尺寸图标（如 `IconChevronDownOutline14`、`IconBranchOutline16`）改为带权重名的 glyph（如 `IconChevronDownOutlineMedium`）。Git 通过本地兼容层先找旧导出，再映射至新 Medium glyph；Menu API 保持可用。
- **当前调用保持兼容：Git 服务与主要 Client 扩展点。** `dsh-subprocess` 保留 `resolveExecutable` / `spawn` 声明；右侧栏插件调用的 `openTab` / `openResource` 和注册所需 SidebarRight tab/resource 类型未改变。
- **上游 bundle 漏声明运行时依赖。** `dsh-client-store@0.1.7-alpha.1` bundle 导入 `zustand` 和 `immer`，但 manifest 未声明它们；严格依赖解析器运行测试时无法解析模块。本包补充 `zustand`（`>=4.4.7 <5`）和 `immer`（`>=10.1.1 <11`）peer，并以匹配上游的开发版本验证。
- **Cordis 跟随宿主副本，不抬高 peer 下限。** 0.1.5-rc.2 到 0.1.6-alpha.2 的宿主是 Cordis `4.0.2`；0.1.7-alpha.1 要求 `^4.0.3`。peer 保持 `>=4.0.2 <5`，因此 4.0.2 宿主仍满足声明。开发 pin 与矩阵车道分别钉到该 DSH 版本声明的精确 Cordis，避免同一棵树里出现两份 Cordis。
- **Session 与 LLM 风险检查：** Session Controller 重组了 subagent catalog 到 projection baseline 的接口，移除若干 catalog 专用成员；插件不调用这些接口，只按 `sessionId` 从 `useSessions(...).byId[id].cwd` 取工作目录。LLM 类型有所扩充/重排，插件依赖的 `GenerateOptions`、`Message`、`MessageId` 与 `TextBlock` 通过候选版构建验证。

候选版本的直接依赖安装后，类型构建、测试及 artifact 检查用于验证上述兼容判断。新的 `ConfigForms.get` 以宿主 Loader 条目的 `options.id` 作为查找键；插件通过补丁行 id `dsh-plugin-git` 读取 Config 表单，旧版仍使用 `git-commit-message` 独立设置 namespace。

## 0.1.7-alpha.2 与 0.1.7-rc.1 接口差异评估

晋级这两个版本前，对照了本地标签 `dsh-v0.1.7-alpha.1`、`dsh-v0.1.7-alpha.2`、`dsh-v0.1.7-rc.1`，以及 npm 发布包的 manifest 与运行时 bundle。插件直接调用的服务在这三段之间没有破坏性改动，已有结构探测继续工作：

- **设置、进程、LLM、侧栏与插槽保持原调用。** `dsh-settings`、`dsh-subprocess`、`dsh-llm`、右侧栏、slots、设置 UI，以及 `useSessions(...).byId[id].cwd`、`modelCatalog`、`currentSelection` 的源码未改。图标导出名不变。`Tooltip` 增加可选 `gap`，`Modal` 增加可选 `onKeyDownCapture`；本插件不传这些参数。Session 分页的 `turnWindow` 与 Conversation 的 preparing/start 工具阶段本插件不调用。
- **schemastery 3.18.4 仍用 `volatile`。** 0.1.7-alpha.1 带 3.18.3；alpha.2 与 rc.1 带 3.18.4。`.volatile()` 与 cosmokit volatile 引用都还在。适配层继续按方法是否存在标记字段，并按 `Symbol.for('cosmokit.volatile.write')` 读取快照。
- **rc.1 宿主按 peer 范围决定是否加载插件。** `app-boot` 的兼容预检用 `semver.satisfies`（含 prerelease）检查每个 `@deepseek-ai/dsh-*` peer。精确 OR 范围里没有该运行时版本时，宿主禁用插件。把 `0.1.7-alpha.2` 与 `0.1.7-rc.1` 写入唯一清单后，peer 范围覆盖这两个宿主。
- **宿主运行时下限从 caret 改为波浪号。** alpha.1 发布 Cordis `^4.0.3` 与 schemastery `^3.18.3`。alpha.2 与 rc.1 发布 Cordis `~4.0.4` 与 schemastery `~3.18.4`。矩阵车道把这两份依赖钉到该范围的精确版本。本包 Cordis peer 仍是 `>=4.0.2 <5`，schemastery 依赖仍是 `>=3.18.2 <4`，因此 4.0.2 / 3.18.2 的旧宿主仍然可加载。
- **没有新的未声明 bundle 依赖。** `dsh-client-store` 仍导入 `zustand` 与 `immer`；primitives bundle 仍导入 `diff` 与 `simple-icons`。已有 peer 覆盖这四个包。

## 静态一致性门禁

上游 DSH 包把同级依赖写成 caret，例如 `^0.1.5-rc.2`。这个范围接受同一 core 上更后的 prerelease，pnpm 在 `autoInstallPeers` 下会装成 registry 里当前最高的匹配版本。只钉住根清单时，锁文件仍会混入 `0.1.5-rc.3`、`0.1.7-alpha.1` 或更旧的 `0.1.1-rc.2`。`.pnpmfile.cjs` 在每次安装时把传递依赖、可选依赖和 peer 里的全部 `@deepseek-ai/dsh-*` 改成当前精确版本。目标版本优先取 `DSH_COMPAT_VERSION`，否则取根 devDependency 的唯一 pin。根清单自己的 devDependency pin 和多版本 peer OR 范围保持不变。

`pnpm compat:check` 在构建之前检查：

1. peer dependencies 是否与精确版本清单一致；
2. 每个 DSH peer 是否有对应开发依赖；
3. 所有 DSH 开发依赖是否 pin 在同一已支持版本；
4. 当前 `node_modules` 中每个已声明的 DSH 包是否存在且解析到该 pin；
5. `pnpm-lock.yaml` 的 `packages` 段里，每个 `@deepseek-ai/dsh-*` 是否都等于该 pin；出现任何其他版本即失败；
6. 已安装的 `@deepseek-ai/dsh-settings` 所声明的 Cordis 与 schemastery caret 或波浪号下限，是否就是当前解析到的精确版本，且本包的 Cordis peer 与 schemastery 依赖范围接受这个副本。

第 6 项挡住「DSH 包是旧版本、Cordis / schemastery 却被漂到新版本」的安装。那种树上类型检查和单测可以通过，真实宿主加载插件时仍会失败。schemastery 的发布范围仍是 `>=3.18.2 <4`，仓库用 `pnpm-workspace.yaml` 的 `overrides` 把当前车道钉到该版本声明的精确副本；Cordis 由开发依赖的精确版本钉住。升级脚本在切换车道时同时改这两处。

主 CI 使用已提交锁文件中的开发 pin，冻结安装后运行兼容门禁、测试、文档检查、构建与 artifact 检查，并保留 pnpm 11 默认的 24 小时发布冷却。`.github/workflows/upgrade.yml` 通过 `scripts/check-dsh-compat.mjs --list-non-default` 从唯一版本清单中动态生成非开发 pin 的矩阵，避免再复制维护版本数组。每个车道切换至对应精确版本后非冻结安装；该 job 设置 `pnpm_config_minimum_release_age=0`，因为这条车道要安装刚发布的 prerelease，豁免不写入 `pnpm-workspace.yaml`。随后运行同一组门禁。两条工作流均不会静默改变支持清单。

该检查保证锁文件中的 DSH 包是同一个版本，不承诺非 DSH 的宿主依赖树没有上游 peer 警告。全宿主依赖图的整合验证需由上游组合仓库负责。

## 候选版本验证与晋级

`.github/workflows/upgrade.yml` 在 PR、main 更新和每周定时执行时回归其余全部受支持版本。手动运行时可传入一个精确 prerelease 版本，以 `DSH_COMPAT_MODE=warn` 验证未列候选；候选模式不修改清单或 peer 声明。

候选车道成功是升级证据，不会自动扩大支持承诺。晋级时应审查上游接口差异与验证结果，然后更新唯一清单和 peer 范围；开发 pin 可按需调整，非默认矩阵由脚本自动随清单扩展。开发 pin 是本地和锁文件的稳定基线；主 CI 验证该 pin，升级矩阵持续回归所有其他承诺版本。

本插件使用标准 Cordis 服务、`ctx.subprocess` 和 Client 类型/服务契约，没有替换宿主 provider 或扩大权限的运行时行为，因此当前只设置仓库与 CI 兼容门禁，不在插件启动时拒绝未知宿主版本。若将来引入依赖不稳定上游内部结构或影响安全边界的行为，应重新评估运行时门禁。

## 相关决策

- [ADR-0003：以精确版本清单承诺 DSH 兼容性](../decisions/ADR-0003-dsh-compatibility-contract.md)
