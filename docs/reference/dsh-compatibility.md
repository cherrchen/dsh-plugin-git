# DSH 兼容契约

- **Status**: Current

## 适配波次状态

自 `dsh-v0.1.5-rc.2` 至 `dsh-v0.2.1-rc.2` 的兼容晋级已完成，区间内十七个已发布精确 prerelease 全部纳入支持。清单写入 [`src/compat/dsh-version.ts`](../../src/compat/dsh-version.ts)，`pnpm compat:check` 与升级 CI 矩阵覆盖除开发 pin 外的全部非默认版本。跨版本行为由 [`src/compat/`](../../src/compat) 内的结构探测承担；下文各节保留晋级时的接口差异评估记录。

## 已验证并承诺支持的版本

唯一版本清单位于 [`src/compat/dsh-version.ts`](../../src/compat/dsh-version.ts)：

- `0.1.5-rc.2`
- `0.1.5-rc.3`
- `0.1.6-alpha.1`
- `0.1.6-alpha.2`
- `0.1.7-alpha.1`
- `0.1.7-alpha.2`
- `0.1.7-rc.1`
- `0.1.7-rc.2`
- `0.2.0-rc.1`
- `0.2.0-rc.2`
- `0.2.1-alpha.1`
- `0.2.1-alpha.2`
- `0.2.1-alpha.3`
- `0.2.1-alpha.4`
- `0.2.1-alpha.5`
- `0.2.1-rc.1`
- `0.2.1-rc.2`

每个 `@deepseek-ai/dsh-*` peer dependency 使用由清单生成的精确 OR 范围。`engines.dsh` 声明与 peer OR 完全相同的精确 OR：自 `0.2.1-alpha.4` 起宿主准入预检在该字段存在时只读它，更早宿主继续读 peer OR；`pnpm compat:check` 强制两者与唯一清单一致。开发依赖与提交锁文件统一 pin 到 `0.2.0-rc.2`。主 CI 使用冻结锁文件验证此开发 pin；DSH 兼容矩阵 CI 从唯一清单选取其余受支持版本，逐版本重新解析依赖并运行相同的兼容检查、测试、文档检查、构建与 artifact 检查。手动 dispatch 可将矩阵指向一个尚未承诺支持的精确 prerelease，以候选模式验证。清单按版本顺序排列并只增不减，已承诺版本不会被后续晋级移除；兼容代码按服务和导出结构选择旧、新接口，不按版本号分支。
跨版本运行时：0.1.5-rc.2 至 0.1.6-alpha.2 使用 Cordis `4.0.2` / schemastery `3.18.2`；0.1.7-alpha.1 使用 `4.0.3` / `3.18.3`；0.1.7-alpha.2 至 0.2.0-rc.2 使用 `4.0.4` / `3.18.4`；0.2.1-alpha.1 与 0.2.1-alpha.2 使用 `4.0.5-alpha.1` / `3.18.5-alpha.1`；0.2.1-alpha.3 至 0.2.1-alpha.5 使用 `4.0.5-alpha.2` / `3.18.5-alpha.2`；0.2.1-rc.1 与 0.2.1-rc.2 改用正式版 `4.0.5` / `3.18.5`。0.2.1 宿主声明的 prerelease 下限分别由 peer `|| ~4.0.5-alpha.1 || ~4.0.5-alpha.2` 与 dependency `|| ~3.18.5-alpha.1 || ~3.18.5-alpha.2` 接受；rc 车道的正式版副本落在 `>=4.0.2 <5` 与 `>=3.18.2 <4` 基础范围内，无需新增 OR 子句；开发 pin 保持 `0.2.0-rc.2`。0.1.5-rc.3 把 Cordis 与 schemastery 从 caret 改写为精确 `4.0.2` / `3.18.2`，与 rc.2 是同一对副本；`scripts/upgrade-dsh.mjs` 与 `scripts/check-dsh-compat.mjs` 的下限解析把 caret、波浪号与精确 pin 统一按声明下限处理。


`dsh-client-ui-primitives` 的发布 bundle 导入 `diff`，但上游没有将其声明为运行时依赖。本插件将 `diff`（`>=9 <10`）声明为 peer。alpha.2 的 bundle 还导入 `simple-icons@16.31.0`，同样未声明运行时依赖；本插件将 `simple-icons`（`>=16.31.0 <17`）声明为 peer，并以 `16.31.0` 做开发依赖 pin。这样严格依赖解析器也能满足上游 bundle 的导入。

`@deepseek-ai/dsh-credentials` 是唯一不随全量清单取范围的 peer：本功能完整 `ctx.credentials` seam 的已验证子集自 `0.2.0-rc.2` 起，其 peer OR 只覆盖 [`src/compat/dsh-version.ts`](../../src/compat/dsh-version.ts) 中 `CREDENTIALS_SEAM_DSH_RELEASES` 声明的 canonical 子集（`0.2.0-rc.2` 至 `0.2.1-rc.2`），并标记 `peerDependenciesMeta.optional`；`pnpm compat:check` 按该子集校验。更早开发车道通过安装 hook 省略根包的 optional peer 开发依赖，构建/测试安装树没有该包：宿主仍能安装、加载本插件并运行本地 Git，远程平台边界把缺失 seam 结构性探测为 `credentials-missing` 的 `off`（见[远程平台 RPC](remote-platform-rpc.md)），不会要求安装不存在的版本。

## 0.1.5-rc.3 接口差异评估

晋级 `0.1.5-rc.3` 前，对比了本插件直接使用的十七个上游包在 `0.1.5-rc.2` 与 `0.1.5-rc.3` 的发布 manifest、`lib/` 运行时 bundle 与类型声明。这是一次仅含 manifest 修订的重发：

- **全部 `lib/` 文件字节一致。** `dsh-subprocess`、`dsh-settings`、`dsh-llm`、`dsh-api-session-controller`、Client UI 各包与 `dsh-client-store` 的运行时和 `.d.ts` 在两个版本间没有任何差异，既有结构探测原样工作。
- **宿主运行时由 caret 改为精确 pin。** `dsh-settings@0.1.5-rc.3` 与 `dsh@0.1.5-rc.3` 把 Cordis、schemastery 写成精确 `4.0.2` / `3.18.2`，不再使用 `^4.0.2` / `^3.18.2`。解析到的是同一对副本，本插件 Cordis peer `>=4.0.2 <5` 与 schemastery 依赖 `>=3.18.2 <4` 均接受。升级脚本和兼容门禁原先把下限写成 `^` / `~` 才接受，已扩展为同时接受精确 pin，否则该车道无法切版本、门禁会把合法宿主判成违规。
- **车道专用包在该版本不存在。** `dsh-util-code-language` 与 `dsh-client-shortcuts` 从 `0.1.7-rc.2` 起才发布；升级脚本按 `npm view` 探测在 rc.3 车道移除这两项 devDependencies，开发 pin 的清单与锁文件不受影响。

候选验证于 2026-10-13 在开发机完成。`DSH_COMPAT_MODE=warn` 安装 `0.1.5-rc.3` 后，`pnpm compat:check`、`pnpm test`（215）、`pnpm docs:check`、`pnpm build` 与 `pnpm test:artifact` 全部通过，随后将版本写入唯一清单与 peer OR。

## alpha.2 接口差异评估

晋级 `0.1.6-alpha.2` 前，对比了本插件直接依赖的 alpha.1 与 alpha.2 发布 manifest 和声明文件，并用候选依赖执行构建与回归：

- `dsh-api-session-controller` 调整 Session 管理契约：列表不再暴露 `current` 选择字段，快照移除了 transient queue；选择与生命周期改由 Session 引用和状态接口表达。本插件只根据注入的 `sessionId` 通过稳定的 `useSessions(...byId[id].cwd)` 取工作目录，因此移除了对 `current` 的结构假设。
- `dsh-client-ui-settings` / `dsh-client-ui-settings-plugins` 从 `0.1.6-alpha.2` 起退役 `settings.plugin.item`。该插槽在 `0.1.5-rc.2` 与 `0.1.6-alpha.1` 仍由「插件」分区的 `configurable` 标签页声明。新宿主把社区插件配置放到插件管理页的 `plugins.bundle.config`，键为包名 `@dsh-electron/dsh-plugin-git`，表单出现在该组合包详情页的描述与组件列表之间。`settings.plugins.tab` 只剩功能标签外壳，不是 Git 的配置入口。适配层在 [`src/compat/dsh-client-settings.ts`](../../src/compat/dsh-client-settings.ts) 同时注册两个 slot；宿主没声明的那个保持挂起，因此各已声明版本只显示自己拥有的一面。
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

## 0.1.7-rc.2 接口差异评估

晋级 `0.1.7-rc.2` 前，对照了本地标签 `dsh-v0.1.7-rc.1` 与 `dsh-v0.1.7-rc.2`，以及 npm 上 primitives 的发布 bundle。插件直接调用的服务没有需要新版本分支的破坏性改动，已有结构探测继续工作：

- **设置、进程、schema、图标与侧栏导航保持原调用。** `dsh-settings` 与 `dsh-subprocess` 源码未改。`.volatile()` 与 cosmokit volatile 引用仍在，schemastery 仍是 `3.18.4`。Git 用的 Medium glyph 名称未改。`openTab` / `openResource`、`useSessions(...).byId[id].cwd`、`currentSelection()` 未改。`GenerateOptions` 增加可选 `toolHistory`；`Menu`、`Modal`、`Tooltip` 与 `Button` 只增加可选参数。`SidebarRightTabActions.bindCommands` 与 `refreshShortcut` 由宿主提供，Git 页面不实现该接口。
- **宿主运行时下限不变。** rc.2 仍发布 Cordis `~4.0.4` 与 schemastery `~3.18.4`。矩阵车道继续钉这两份依赖的精确下限。Cordis peer 与 schemastery 依赖下限不抬高。
- **rc.2 的 primitives bundle 新增未声明的 DSH 运行时导入。** `@deepseek-ai/dsh-client-ui-primitives@0.1.7-rc.2` 的 `lib/index.js` 顶层导入 `@deepseek-ai/dsh-util-code-language`。该包只在 `0.1.7-rc.2` 发布，上游只把它写成 devDependency。右侧栏类型同时引用只在该版本发布的 `@deepseek-ai/dsh-client-shortcuts`。这两个名字不能写进与支持清单相同的 peer OR：`app-boot` 用宿主版本满足每一个 `@deepseek-ai/dsh-*` peer，而 `.pnpmfile.cjs` 会把这类依赖改写成当前 pin；开发 pin `0.1.5-rc.2` 上这两个包不存在。升级脚本只在 `npm view` 能看到目标精确版本时，把它们写入该车道的 devDependencies。开发 pin 的清单和锁文件不加这两项。已有的 `diff`、`simple-icons`、`zustand` 与 `immer` peer 继续覆盖更早的未声明导入。

## 0.2.0-rc.1 与 0.2.0-rc.2 接口差异评估

晋级这两个版本前，对照了本地标签 `dsh-v0.1.7-rc.2`、`dsh-v0.2.0-rc.1`、`dsh-v0.2.0-rc.2`，以及 npm 发布包。`0.1.7-rc.2` 之后没有 0.1.8 / 0.1.9。两候选均以 `DSH_COMPAT_MODE=warn` 通过兼容检查、测试、构建与 artifact 检查；写入清单后对全部九个精确版本重建安装树并正式门禁通过。已有结构探测继续工作，没有新增 `src/compat/` 分支。

- **必须处理：peer OR。** 每个 `@deepseek-ai/dsh-*` 包随发行版 lockstep 升到 `0.2.0-rc.1` / `0.2.0-rc.2`。`app-boot` 仍用 `semver.satisfies`（含 prerelease）预检；精确 OR 没有这两个版本时新宿主禁用插件。清单加入后 peer 范围覆盖这两个宿主。
- **插件直接调用的服务源码未改。** `dsh-subprocess` 的 `resolveExecutable` / `spawn`、`dsh-settings.configure({ auto: false })`、`dsh-llm` 的 `GenerateOptions` 与 `stream` `text-delta`、`configForms.get`、slots `conversation.input.left` / `sidebar.right.pane.tab`、`useSessions(...).byId[id].cwd`、`openTab` / `openResource` 方法签名均保持。`Button`、`Menu`/`MenuEntry`（含 `type: 'label'` 与 `text`）、`Tooltip` 的 `label` / `side` / `delayMs`，以及 Git 使用的五个 Medium glyph 仍导出；primitives 只增加可选参数与 `MenuGroup`。
- **宿主运行时下限不变。** 两个 0.2.0 发行版仍发布 Cordis `~4.0.4` 与 schemastery `~3.18.4`。矩阵车道钉该范围的精确下限。本包 Cordis peer 与 schemastery 依赖下限不抬高。
- **0.2.0-rc.2 右侧栏内部重构（rc.1 仍为旧模型）。** 公开类型 `SidebarRightBinding` 被删除；`ISidebarRight.mounted` 从「seat 已 bind 的 session」改为「屏幕上的 session」，并在 React 渲染前发布。本插件不导入 `SidebarRightBinding`、不读 `mounted`、不调 `bind`，只调用 `openTab` 与 `openResource`。无 session 选中时仍抛 `sidebarRight: no session surface is mounted`。仓库测试使用 fake，不覆盖真实 `mounted` 时序。
- **0.2.0 新增包不进入 peer OR。** `@deepseek-ai/dsh-client-product-analytics`、`dsh-otel`、`dsh-experimental-schedule-bundle` 与 `dsh-client-ui-settings-session-log` 仅从 0.2.0-rc.1 发布。conversation 对 product-analytics 是类型侧 `import type {}` 与 devDependency；候选类型构建与测试未要求安装该包。把它们写成与支持清单相同的 peer OR，会让旧宿主的 `app-boot` 预检失败。
- **车道专用包继续按发布探测。** `dsh-util-code-language` 与 `dsh-client-shortcuts` 在 `0.1.7-rc.2`、`0.2.0-rc.1` 与 `0.2.0-rc.2` 均有发布。开发 pin 现为 `0.2.0-rc.2`，提交锁文件包含这两项；它们仍不进入 peer OR。升级脚本只在 `npm view` 看到目标精确版本时把它们写入该车道的 devDependencies，切到更早发行版时再移除。0.2.0 的 primitives 发布 bundle 仍顶层导入 `dsh-util-code-language`，并额外导入 `dsh-util-workspace-path`；后者由传递依赖装上，不进入 peer OR。已有的 `diff`、`simple-icons`、`zustand` 与 `immer` peer 继续覆盖更早的未声明导入。

## 官方 DiffBlock 接入

Git Client 从 primitives 的公开入口复用 `DiffBlock`，不导入官方 `ui-deliverables` 的私有 `FileDiff` 源码，也不要求改动 DSH 宿主。官方完整 `changes-review` 页面绑定会话回合的变更记录，不能直接代替 Git 的 index/HEAD/worktree 比较；本插件保留原有 `git.diff` 地址与取数适配，只删除自写的 patch 行渲染与样式。渲染职责见[架构总览](../architecture/overview.md)。

`0.1.5-rc.2` 的组件把 old/new 片段中的每行当作移除/添加；自 `0.1.6-alpha.1` 起，组件比较片段并保留共享上下文。`src/compat/dsh-diff.ts` 用公开纯函数 `diffTotals` 对相同文本的计数探测该行为：支持上下文时传完整 hunk，否则只传由上下文隔开的修改片段，避免把未修改行当成更改。旧版的 `files(count)` labels 与新版的 code/wrap/unwrap labels 同时提供，中文和英文都由 Git 字典拥有。支持清单和开发 pin 不变。

新增的 `tests/dsh-diff.client.spec.ts` 在矩阵每个车道使用该车道实际安装的官方组件计数，验证共享上下文不会增加编辑数；详情面板与并发面板测试直接渲染官方组件，覆盖复制控件、折叠、地址恢复、再次导航与结果隔离。新增 adapter 规格用临时仓库的真实 Git patch 验证增删、暂存/工作区、Unicode 路径、二进制、重命名与缺少末尾换行，并拒绝截断输出。

本次迁移对开发 pin `0.2.0-rc.2` 运行完整测试、构建与产物检查；其余八个支持版本分别在临时目录重建安装树，通过兼容门禁、78 项相关回归、构建与产物检查。实际开发安装树、manifest 与 lockfile 保持原 pin。未进行真实 Web/Desktop 浏览器交互验证。

## 0.2.1-alpha.1 与 0.2.1-alpha.2 接口差异评估

`0.2.1-alpha.2` 与 `0.2.1-alpha.1` 均已写入 [`src/compat/dsh-version.ts`](../../src/compat/dsh-version.ts) 与 peer OR。开发 pin 与锁文件仍保持 `0.2.0-rc.2`，候选验证不会改变默认开发基线。

对照本地标签 `dsh-v0.2.0-rc.2`、`dsh-v0.2.1-alpha.1`、`dsh-v0.2.1-alpha.2` 的公开源码与 npm 发布包后，和本插件有关的差异如下。工作目录与 worktree 只在 `0.2.1-alpha.2` 出现；`0.2.1-alpha.1` 没有这两个包，该版本宿主不携带有效目录投影，插件继续回落到会话头 `cwd`。

- **必须适配：有效目录不再等于会话头 `cwd`。** `0.2.1-alpha.2` 的 `ctx.workingDirectory` 把原始项目路径留在会话头，把有效目录记成投影 `workingDirectory`，并由 Session Controller 的控制帧推到客户端 `projectionValues`。`useSessions(...byId[id].cwd)` 仍是原始项目路径，不会随 `working-directory/change` 更新。插件在投影值为非空字符串时使用它，否则继续用会话头 `cwd`。旧宿主没有该键，行为与原来一致。
- **必须适配：写操作不能停在上一个检出。** 目录变化时，该会话的 Client 控制器中止旧绑定的 `/git` RPC 与尚未发出的写操作；已发出的工作树创建使用独立请求信号等待结果，避免其自身的目录投影取消成功回执，控制器卸载仍取消创建。宿主在 `agents.get` 与 `workingDirectory.get` 都能调用、且会话 agent 仍活着时，拒绝仓库根与该有效目录检出不一致的写请求。没有这两个服务、没有活 agent，或请求没带 `sessionId` 时，仍使用调用方给出的仓库路径。不使用进程级 `process.cwd()`。
- **优先协作上游，按设置启用本地 worktree 创建。** 本插件结构性探测 `ctx.worktrees.create`；上游运行时存在时，创建委托它执行，并由上游调用 `workingDirectory.set`。未挂载上游且 `git-worktrees.enabled` 为真时，本插件提供本地 `git worktree add -b` 创建；两者皆无时关闭创建。本插件不注册竞争模型工具，也不删除、修剪分支或检出。创建模式、检出池配置与动态 tab 生命周期以[架构总览的 Worktree 边界](../architecture/overview.md)为准。它用 `git worktree list --porcelain -z`（旧 Git 回退到换行形式）发现全部来源的检出，区分主检出与 linked checkout。用户选择「在此会话中使用」时，宿主只对列表中的路径调用 `workingDirectory.set`。目录服务不存在，或请求中的会话没有活 agent 时，进入操作不可用，本地创建仍可执行；上游创建需要活 agent。Changes / Diff / Graph / Commit 仍可用。
- **插件直接调用的其他服务没有新的版本分支。** `dsh-subprocess` 的 `resolveExecutable` / `spawn` 签名保持。`0.2.1-alpha.2` 的 subprocess-local 只调整 Windows 终端 host，Git 的管道 spawn 不依赖它。右侧栏 `openTab` / `openResource` 保持；内部 reveal 规则有调整，本插件不读 `mounted`。设置 slot `settings.plugin.item` 与 `plugins.bundle.config` 仍在。`GenerateOptions` 与 `stream` 的 `text-delta` 仍是提交信息生成所用的形状；`prepareCall` 增加的可选参数本插件不传。Conversation 的 `bindDraftMirror` 改名为 `bindDraftPersistence`，改名随 `0.2.1-alpha.1` 落地，Git 不使用该回调。
- **alpha.1 相对 0.2.0 的其余差异均为新增而非破坏。** Session Controller 增加可选 `listWorkSliceMs` 部署项；Conversation 增加 `ToolArgs`/`PartialArguments` 工具参数视图、`DraftInput` 草稿类型与 `requestDraftInitialization`；primitives 增加 `InlineEditor` 导出。插件不调这些接口；`conversation.input.left` 契约、`useSessions(...byId[id].cwd)` / `projectionValues` 形状、Medium glyph、`diffTotals` / `DiffBlock` 标签、`Menu` / `Tooltip` 在两侧均保持。alpha.1 bundle 没有新增未声明的运行时导入，车道专用包 `dsh-util-code-language` 与 `dsh-client-shortcuts` 在该版本均有发布。
- **不能写进 peer OR 的新包。** `@deepseek-ai/dsh-working-directory`、`@deepseek-ai/dsh-tool-working-directory`、`@deepseek-ai/dsh-experimental-worktree` 与 `@deepseek-ai/dsh-experimental-tool-worktree` 从 `0.2.1-alpha.2` 起才存在。把它们写成与支持清单相同的 peer OR 会让旧宿主的 `app-boot` 预检失败。插件用方法形状探测 `agents`、`workingDirectory` 与 `worktrees`，不从这些包导入。

候选验证分两次在开发机完成。2026-10-10 以 `DSH_COMPAT_MODE=warn` 分别安装 `0.2.1-alpha.1` 与 `0.2.1-alpha.2` 后，两条车道的 `pnpm compat:check`、`pnpm test`（207）、`pnpm docs:check`、`pnpm build` 与 `pnpm test:artifact` 都通过；当时只将经过接口评估与 Web 会话验证的 `0.2.1-alpha.2` 纳入支持清单。2026-10-13 以 `DSH_COMPAT_MODE=warn` 重新安装 `0.2.1-alpha.1`，`pnpm compat:check`、`pnpm test`（215）、`pnpm docs:check`、`pnpm build` 与 `pnpm test:artifact` 再次全部通过，`0.2.1-alpha.1` 随之写入唯一清单与 peer OR。候选安装树对上游 `@deepseek-ai/cordis-plugin-include@~1.0.10-alpha.1` 与 `@deepseek-ai/cordis-plugin-group@~1.0.5-alpha.1` 有 peer 警告；那两个包不是本插件的 peer。开发 pin 与锁文件保持 `0.2.0-rc.2`。

同日用本地源码检出的 DSH `0.2.1-alpha.2`（`d743267388`）启动了 Web 浏览器会话。隔离的 `DSH_HOME` 把本分支构建产物以本地链接装进 `web` profile；当时 `0.2.1-alpha.2` 尚不在支持清单中，加载前授予了 `@dsh-electron/dsh-plugin-git@0.2.4` 对这一精确宿主版本的豁免。会话工作区是主检出里的子目录。Git 更改面板读到父仓库分支 `main`，列出主检出的未跟踪文件，并在「其他检出」中给出链接工作树和「在此会话中使用」。点选之后，会话头 `cwd` 仍是该子目录，有效目录投影变为链接工作树；面板改为 `feature · 链接的工作树`，只显示该工作树自己的未跟踪文件。在面板里暂存这个文件时，写入落在链接工作树，主检出的未跟踪文件保持未暂存；取消暂存后两边都回到验证开始时的状态。再选回主检出后，面板恢复主检出的文件，有效目录投影变为主检出根，会话头 `cwd` 不变。同一工作区里另一个尚未切换的空白会话，其有效目录投影仍停在子目录。宿主侧边栏只显示当前空白会话，所以这一隔离没有在界面上点选复核。没有启动 Desktop，也没有配置模型，因此没有覆盖提交信息生成。

## 0.2.1-alpha.3 接口差异评估

晋级 `0.2.1-alpha.3` 前，对照了本地标签 `dsh-v0.2.1-alpha.2` 与 `dsh-v0.2.1-alpha.3` 的公开源码，以及 npm 发布包的 manifest 与运行时 bundle。本插件直接调用的服务没有破坏性改动，已有结构探测继续工作，没有新增 `src/compat/` 分支：

- **必须处理：peer OR 与运行时下限。** 每个 `@deepseek-ai/dsh-*` 包 lockstep 升到 `0.2.1-alpha.3`；`app-boot` 的兼容预检要求精确 OR 覆盖该版本。宿主运行时声明的下限从 Cordis `~4.0.5-alpha.1` / schemastery `~3.18.5-alpha.1` 抬到 `~4.0.5-alpha.2` / `~3.18.5-alpha.2`，兼容门禁按声明下限检查实际解析副本，因此 Cordis peer 与 schemastery 依赖各追加一条 `|| ~*-alpha.2` 子句；旧子句保留，alpha.1/alpha.2 车道仍解析到 `4.0.5-alpha.1` / `3.18.5-alpha.1`。
- **插件直接调用的服务源码未改。** `dsh-subprocess`、`dsh-subprocess-local`、`dsh-settings`、`dsh-agent-default-model`、`dsh-working-directory`、`dsh-util-code-language`、`dsh-client-locale`、`dsh-client-ui-sidebar-right`、`dsh-client-ui-settings-plugins` 等包的 `src/` 没有差异，只 bump 版本与 locale。`ctx.agents.get`、`workingDirectory.get` / `set`、`ctx.worktrees.create` 的调用形状保持；worktree 服务内部把 `--no-lazy-fetch` 参数换成 `GIT_NO_LAZY_FETCH` 环境变量，不经本插件接口。
- **Client 侧差异均为新增或本插件未读字段的收缩。** `SessionSummary.cwd` 与 `projectionValues` 保持，`sessions.create` 只增加可选 `agentPreset`；`connection` 的 `ConnectionHandle.rpc` 保持，`/client` 入口拆成 browser/node 两份构建而 types 路径不变，`OperatorPeer` 改名 `Peer` 属宿主内部重构；Conversation 增加 `conversation.user.text`、`conversation.images.content`、`conversation.hero.options` 等插槽，`conversation.input.left` 契约不变；primitives 移除 `projectUserText` / `UserTextReferences`（本插件未使用），新增 `HoverCardGroup`，`DiffBlock` / `diffTotals` / `SettingsForm` / `Menu` / `Tooltip` / `Button` / `Modal` / `Input` / `Tag` / `Switch` 与全部 Medium glyph 保持导出；`ConfigFormSnapshot` 移除 `mode` 字段，本插件只读 `status` / `writable` / `revision` / `value`；`ui-slots` 增加 `inline` 选项与 keyed hook 的 `member` 形参；`dsh-llm` 增加可选的 `imageRequestTarget` 与 `LlmNativeAuth` 等字段，`GenerateOptions` 与 `stream` 的 `text-delta` 未改；`ui-session` 自身的 client inject 增加 `remoteAccess`，属宿主组合而非本插件声明。
- **不能写进 peer OR 的新包。** `@deepseek-ai/dsh-api-remote-access` 从 `0.2.1-alpha.3` 起才发布；写成与支持清单相同的 peer OR 会让旧宿主的 `app-boot` 预检失败。本插件不从该包导入。
- **没有新的未声明 bundle 依赖。** primitives、client-store、conversation、sidebar-right、connection、ui-session、ui-settings、ui-renderer、ui-slots 与 session-controller 的发布 bundle 顶层导入清单与 alpha.2 逐项一致；已有的 `diff`、`simple-icons`、`zustand` 与 `immer` peer 继续覆盖未声明导入。schemastery `3.18.5-alpha.2` 保留 `.volatile()` 与 cosmokit volatile 引用语义，适配层原样工作。

候选验证于 2026-10-15 在开发机完成。`DSH_COMPAT_MODE=warn` 安装 `0.2.1-alpha.3` 后，`pnpm compat:check`、`pnpm test`（299）、`pnpm docs:check`、`pnpm build` 与 `pnpm test:artifact` 全部通过；候选安装树对上游 `@deepseek-ai/cordis-plugin-include@~1.0.10-alpha.2` 与 `@deepseek-ai/cordis-plugin-group@~1.0.5-alpha.2` 有 peer 警告，那两个包不是本插件的 peer。随后在 alpha.3 安装树上以正式门禁重跑 `pnpm compat:check` 通过，开发 pin 与锁文件恢复 `0.2.0-rc.2`。

## 0.2.1-alpha.4 接口差异评估

晋级 `0.2.1-alpha.4` 前，对照了本地标签 `dsh-v0.2.1-alpha.3` 与 `dsh-v0.2.1-alpha.4` 的公开源码，以及 npm 发布包的 manifest 与运行时 bundle。本插件直接调用的服务没有破坏性改动，已有结构探测继续工作：

- **必须处理：peer OR、`engines.dsh` 与插件准入预检。** 每个 `@deepseek-ai/dsh-*` 包 lockstep 升到 `0.2.1-alpha.4`。`app-boot` 兼容预检与 `plugin-manager` 改为先读插件 manifest 的 `engines.dsh`：该字段存在时由它单独判定准入，不再逐一检查 peer；字段缺失时回退原有的 `@deepseek-ai/dsh-*` peer `semver.satisfies`（含 prerelease）检查。本插件新增 `engines.dsh` 声明，内容与 peer 精确 OR 完全一致，`pnpm compat:check` 校验两者与唯一清单同步；旧宿主忽略该字段，准入行为不变。上游 `PluginCompatibility.peers` 改名 `requirements`，属宿主内部结构，本插件不消费。
- **插件直接调用的服务源码未改。** `dsh-subprocess`、`dsh-settings`、`dsh-llm`、`dsh-api-session-controller`、`dsh-client-connection`、`dsh-client-ui-session`、`dsh-client-ui-sidebar-right`、`dsh-client-ui-slots`、`dsh-client-ui-primitives`、`dsh-client-ui-settings` / `-plugins`、`dsh-client-locale`、`dsh-client-resources`、`dsh-client-store`、`dsh-agent-default-model`、`dsh-util-code-language`、`dsh-working-directory` 与 `dsh-experimental-worktree` 在 alpha.3→alpha.4 间只有 manifest 版本 bump。`resolveExecutable` / `spawn`、`configForms.get`、`useSessions(...byId[id].cwd)` / `projectionValues`、`openTab` / `openResource`、`GenerateOptions` 与 `stream` 的 `text-delta`、`conversation.input.left`、Medium glyph、`diffTotals` / `DiffBlock` 标签等接缝全部保持。
- **`ui-conversation` 输入机内部重构。** alpha.4 把斜杠命令从触发词文本改为编辑器内 command chip，`InputEvent` / `DraftSnapshot` 相应调整并新增 `resolveClaim`。Git 只占用 `conversation.input.left` 插槽，不实现 `InputTriggerController`，该插槽契约与渲染路径未变。
- **`dsh-subprocess-local` 的 Linux 容器选择重构为可失效重探的选择器。** 仅影响 Linux 上 systemd scope 决策与 terminal 启动路径；本插件经 `dsh-subprocess` 以独立 argv 调用 `git`，不经 PTY，接口未变。
- **宿主运行时下限不变。** alpha.4 仍声明 Cordis `~4.0.5-alpha.2` 与 schemastery `~3.18.5-alpha.2`；既有 `|| ~*-alpha.2` 子句已覆盖，不再追加。
- **不能写进 peer OR 的新包。** plugin-market 家族（`dsh-plugin-market`、`dsh-client-ui-plugin-market`、`dsh-util-plugin-market-index`、`dsh-experimental-plugin-market-bundle`）从 `0.2.1-alpha.4` 起才发布；写成与支持清单相同的 peer OR 会让旧宿主预检失败。本插件不从这些包导入。
- **没有新的未声明 bundle 依赖。** 对本插件消费的十七个上游包逐一比对 alpha.3 与 alpha.4 tarball 的运行时顶层导入，清单逐项一致；`diff`、`simple-icons`、`zustand` 与 `immer` peer 继续覆盖既有未声明导入。schemastery `3.18.5-alpha.2` 的 `.volatile()` 与 cosmokit volatile 引用语义不变，适配层原样工作。

候选验证于 2026-10-16 在开发机完成。`DSH_COMPAT_MODE=warn` 安装 `0.2.1-alpha.4` 后，`pnpm compat:check`、`pnpm test`（299）、`pnpm docs:check`、`pnpm build` 与 `pnpm test:artifact` 全部通过；随后在候选安装树上以正式门禁重跑 `pnpm compat:check` 通过，开发 pin 与锁文件恢复 `0.2.0-rc.2`。

同日在开发机用发布的 `@deepseek-ai/dsh@0.2.1-alpha.4` npm 包启动隔离 `DSH_HOME` 的 Web 宿主做实机验证：`dsh plugin --profile web add` 装入本分支构建的 tarball，准入预检直接读取新增的 `engines.dsh` 并通过，组合树出现 `dsh-plugin-git` 行；启动无告警，客户端 bundle 正常供给。浏览器会话中 Git 三个侧栏页（Changes / Diff / Graph / Worktrees）按真实仓库状态渲染，暂存与取消暂存写操作落在正确仓库根，插件管理页该 bundle 的配置卡正常渲染。未配置模型，未覆盖提交信息生成。

## 0.2.1-alpha.5 ~ 0.2.1-rc.2 接口差异评估

晋级 `0.2.1-rc.2` 时一并审查了 `0.2.1-alpha.5` 与 `0.2.1-rc.1` 两个中间发布，对照本地标签 `dsh-v0.2.1-alpha.4` 至 `dsh-v0.2.1-rc.2` 的公开源码，以及 npm 发布包的 manifest、类型声明与运行时 bundle。本插件直接调用的服务没有破坏性改动，已有结构探测继续工作，没有新增 `src/compat/` 分支：

- **必须处理：peer OR 与 `engines.dsh`。** 每个 `@deepseek-ai/dsh-*` 包 lockstep 升至 `0.2.1-rc.2`；唯一清单、peer 精确 OR 与 `engines.dsh` 各追加 `0.2.1-alpha.5`、`0.2.1-rc.1`、`0.2.1-rc.2` 三个版本。`engines.dsh` 准入语义不变。
- **宿主运行时下限回到正式版。** alpha.5 仍声明 Cordis `~4.0.5-alpha.2` 与 schemastery `~3.18.5-alpha.2`；rc.1 与 rc.2 改用正式版 `~4.0.5` / `~3.18.5`。稳定副本 `4.0.5` / `3.18.5` 已落在 Cordis peer `>=4.0.2 <5` 与 schemastery 依赖 `>=3.18.2 <4` 的基础范围内，未新增 OR 子句；既有 `|| ~*-alpha.1/2` 子句继续服务 alpha 车道。
- **插件直接消费的包只有版本 bump。** `dsh-subprocess`、`dsh-subprocess-local`、`dsh-settings`、`dsh-llm`、`dsh-api-session-controller`、`dsh-client-connection`、`dsh-client-locale`、`dsh-client-resources`、`dsh-client-store`、`dsh-client-shortcuts`、`dsh-client-ui-conversation`、`dsh-client-ui-primitives`、`dsh-client-ui-renderer`、`dsh-client-ui-session`、`dsh-client-ui-settings` / `-plugins`、`dsh-client-ui-slots`、`dsh-client-ui-layout`、`dsh-experimental-worktree`、`dsh-util-code-language` 与 `dsh-working-directory` 在 alpha.4→rc.2 间 `src/` 与类型声明无接口差异。仅有的两处 artifact 差异：`dsh-client-ui-sidebar-right` 面板样式补 `overflow:clip`（对应 alpha.5 修复 Page Up 使界面左偏的问题）与 `dsh-client-ui-dockkit` 的 `DockLayout` JSDoc 澄清，均不改变插件消费的 API。`resolveExecutable` / `spawn`、`configForms.get`、`useSessions(...byId[id].cwd)` / `projectionValues`、`openTab` / `openResource`、Medium glyph、`diffTotals` / `DiffBlock`、`conversation.input.left`、`ctx.worktrees.create` 形状探测等接缝全部保持。
- **rc 波次新增能力均不经本插件接缝。** 上游新增 `conversation.input.model.label` 插槽、`working_directory` 工具、插件启用/停用/更新后的依赖同步与热重载、自定义插件索引源等；均不改变本插件声明的插槽或服务契约。官方实验性 Git Worktrees 组合包 `dsh-experimental-tool-worktree` 自 `0.2.1-alpha.3` 起发布，其挂载的 `ctx.worktrees` 运行时本插件已通过 `isUpstreamWorktrees` 结构探测委托。
- **不能写进 peer OR 的新包。** `dsh-client-ui-deepseek-model-label-1017` 从 `0.2.1-rc.2` 起才发布；写成与支持清单相同的 peer OR 会让旧宿主预检失败，本插件不导入。lane 专用包 `dsh-util-code-language` 与 `dsh-client-shortcuts` 在三个候选版本均已发布，升级脚本原样探测保留。
- **没有新的未声明 bundle 依赖。** 对本插件消费的二十三个上游包逐一比对 alpha.4 与 rc.2 tarball 的运行时顶层导入，清单逐项一致；`diff`、`simple-icons`、`zustand` 与 `immer` peer 继续覆盖既有未声明导入。schemastery 正式版 `3.18.5` 的 `.volatile()` 与 cosmokit volatile 引用语义不变，适配层原样工作。

候选验证于 2026-10-17 在开发机完成。`DSH_COMPAT_MODE=warn` 下分别以 `0.2.1-alpha.5`、`0.2.1-rc.1`、`0.2.1-rc.2` 三条车道安装，`pnpm compat:check`、`pnpm test`（299）、`pnpm docs:check`、`pnpm build` 与 `pnpm test:artifact` 全部通过；晋级清单写入后在 `0.2.1-rc.2` 安装树上以正式门禁重跑 `pnpm compat:check` 通过，开发 pin 与锁文件恢复 `0.2.0-rc.2`。

## Session 日志的回读边界（降级不可读）

宿主持久化读路径拒绝解释包含未知必需事件的日志：`dsh-session-persistence` 对不在 `KNOWN_SESSION_EVENT_TYPES` 且未标 `ignorable` 的事件直接拒绝。`0.2.1-alpha.3` 起写入方新增 `job/registered` / `job/settled` 两个必需事件（后台作业登记，agent 的 bash 调用即产生）；因此凡在 ≥ `0.2.1-alpha.3` 宿主上运行过这类作业的会话，回到 `0.2.1-alpha.2` 及更早版本（含 `0.2.0-rc.2`）打开时，历史加载以 `SESSION_QUERY_PERSISTENCE_FAILED` 失败。这是上游刻意的前向兼容防护，与本插件的支持声明无关——插件不读 Session 日志，宿主该行为不受插件影响。症状与解法见 [troubleshooting 条目](../troubleshooting/session-log-newer-harness.md)。

## 静态一致性门禁

上游 DSH 包把同级依赖写成 caret，例如 `^0.1.5-rc.2`。这个范围接受同一 core 上更后的 prerelease，pnpm 在 `autoInstallPeers` 下会装成 registry 里当前最高的匹配版本。只钉住根清单时，锁文件仍会混入 `0.1.5-rc.3`、`0.1.7-alpha.1` 或更旧的 `0.1.1-rc.2`。`.pnpmfile.cjs` 在每次安装时把传递依赖、可选依赖和 peer 里的全部 `@deepseek-ai/dsh-*` 改成当前精确版本。目标版本优先取 `DSH_COMPAT_VERSION`，否则取根 devDependency 的唯一 pin。根清单自己的 devDependency pin 和多版本 peer OR 范围保持不变。

`pnpm compat:check` 在构建之前检查：

1. peer dependencies 与 `engines.dsh` 是否与精确版本清单一致；
2. 每个 DSH peer 是否有对应开发依赖；
3. 所有 DSH 开发依赖是否 pin 在同一已支持版本；
4. 当前 `node_modules` 中每个已声明的 DSH 包是否存在且解析到该 pin；
5. `pnpm-lock.yaml` 的 `packages` 段里，每个 `@deepseek-ai/dsh-*` 是否都等于该 pin；出现任何其他版本即失败；
6. 已安装的 `@deepseek-ai/dsh-settings` 所声明的 Cordis 与 schemastery caret 或波浪号下限，是否就是当前解析到的精确版本，且本包的 Cordis peer 与 schemastery 依赖范围接受这个副本。

第 6 项挡住「DSH 包是旧版本、Cordis / schemastery 却被漂到新版本」的安装。那种树上类型检查和单测可以通过，真实宿主加载插件时仍会失败。schemastery 依赖保持 `>=3.18.2 <4`，并另有一条 `|| ~3.18.5-alpha.1` 以接受 0.2.1 候选宿主的 prerelease 副本；Cordis peer 同样在 `>=4.0.2 <5` 之外接受 `~4.0.5-alpha.1`。仓库用 `pnpm-workspace.yaml` 的 `overrides` 把当前车道钉到该版本声明的精确副本；Cordis 由开发依赖的精确版本钉住。升级脚本在切换车道时同时改这两处，波浪号下限里的 prerelease 也算精确 pin。

主 CI 使用已提交锁文件中的开发 pin，冻结安装后运行兼容门禁、测试、文档检查、构建与 artifact 检查，并保留 pnpm 11 默认的 24 小时发布冷却。开发 pin 若发布未满 24 小时，把该 pin 在锁文件中的精确 `@deepseek-ai/dsh-*` 版本写入 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`，并整表替换旧 pin，让冻结安装能解析已提交锁文件。pnpm 11.7 对同一个包名只认第一条 `name@version`，追加新 pin 不会覆盖旧条目。这不是给未列入清单、也不是给混装的 prerelease 开白名单。`.github/workflows/upgrade.yml` 通过 `scripts/check-dsh-compat.mjs --list-non-default` 从唯一版本清单中动态生成非开发 pin 的矩阵，避免再复制维护版本数组。每个车道切换至对应精确版本后非冻结安装；该 job 设置 `pnpm_config_minimum_release_age=0`，因为这条车道要安装刚发布的 prerelease，豁免不写入 `pnpm-workspace.yaml`。随后运行同一组门禁。两条工作流均不会静默改变支持清单。

该检查保证锁文件中的 DSH 包是同一个版本，不承诺非 DSH 的宿主依赖树没有上游 peer 警告。全宿主依赖图的整合验证需由上游组合仓库负责。

## 候选版本验证与晋级

`.github/workflows/upgrade.yml` 在 PR、main 更新和每周定时执行时回归其余全部受支持版本。手动运行时可传入一个精确 prerelease 版本，以 `DSH_COMPAT_MODE=warn` 验证未列候选；候选模式不修改清单或 peer 声明。

候选车道成功是升级证据，不会自动扩大支持承诺。晋级时应审查上游接口差异与验证结果，然后更新唯一清单和 peer 范围；开发 pin 可按需调整，非默认矩阵由脚本自动随清单扩展。开发 pin 是本地和锁文件的稳定基线；主 CI 验证该 pin，升级矩阵持续回归所有其他承诺版本。

本插件使用标准 Cordis 服务、`ctx.subprocess` 和 Client 类型/服务契约，没有替换宿主 provider 或扩大权限的运行时行为，因此当前只设置仓库与 CI 兼容门禁，不在插件启动时拒绝未知宿主版本。若将来引入依赖不稳定上游内部结构或影响安全边界的行为，应重新评估运行时门禁。

## 相关决策

- [ADR-0003：以精确版本清单承诺 DSH 兼容性](../decisions/ADR-0003-dsh-compatibility-contract.md)

## 远程平台续作验收

Remote 的可选 seam 使用本地结构契约（`src/remote/credentials-types.ts`），生产源码/发布声明不要求旧宿主解析不存在的 credentials 包。新车道通过 optional peer/dev pin 与已发布构造器差分测试核对 key/ref 语法；旧车道不要求此 peer 拥有开发 pin，矩阵需检查真实安装树中该包缺失。主车道与完整矩阵的本次结果记录在[远程集成计划](../plans/active/remote-platform-integration.md)，不以开发 pin 的通过替代逐车道证据。
