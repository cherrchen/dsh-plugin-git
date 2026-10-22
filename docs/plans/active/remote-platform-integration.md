中文 | [English](remote-platform-integration.en.md)

# Plan: 远程平台集成（ADR-0004）

- **Status**: In progress
- **Started**: 2026-10-22
- **Completed**:

## 背景

**Current**：远程平台实现已落地，完整外部/平台验收仍待完成；现有本地 Git 功能及旧宿主支持仍是基线。[ADR-0004 的最终 Decision](../../decisions/ADR-0004-remote-platform-integration.md#decision) 是本计划唯一的设计依据（下文条款号均指该节），不从历史评审讨论重建决策。技术评审项已经闭合，但 ADR 状态仍是 **Proposed（待冻结）**；用户授权开始实施不等于自动晋级为 Accepted。

**Planned / In progress**：按 S0→S7 的依赖顺序实现完整 ADR。S0 分析/文档与 S1 安全契约/Host 边界已落地；S1 只交付 fail-closed 边界（结构化 `off` 应答与 `git/remote-unavailable` 拒绝），不能据此宣称远程功能完成。S2–S6 的认证、REST、Git 集成、受保护写与 Client 已接入，S7 通知实现已接入。完整 seam 下提供远程入口；旧宿主仍 fail-closed。阶段自动验证与完整矩阵/真实平台验收分别记录，尚未完成全部验收，不归档本计划。

## 目标

### 需求分析

| 需求 | 可验收结果 | 阶段 |
| --- | --- | --- |
| 可移植远程入口 | 主 Client fiber 的右侧栏 `git.remote`；GitHub 为首个 provider，中立模型不绑定 GitHub UI；旧宿主仍可加载并使用本地 Git | S1、S3、S6、S7 |
| PR 全流程 | 列表、详情、文件比较、PR 评论、行内评论和 approve/comment/request-changes review、checkout、创建、关闭、合并 | S3–S6 |
| Issue 有限范围 | 列表、详情、评论只读；通过现有分支能力创建 `issue-{n}-{slug}` | S3、S4、S6 |
| 身份与权限安全 | credentials seam 全有或全无；存储可写不等于认证，更不等于仓库/动作权限；所有写操作绑定仓库、稳定 viewer 和单一凭据快照 | S1–S3、S5 |
| 失败与并发诚实 | 刷新发送意图持久化、可能已消费的刷新不重放；checkout 核验 SHA、保护 tracking 并发、回报部分完成；远端写未知结果不冒充失败/成功 | S2、S4、S5 |
| 生命周期与预算 | 卸载停止准入并取消/等待所属工作；账户缓存隔离、限流退避、通知去重；Desktop 只作可卸载增强 | S2、S3、S6、S7 |

验收不能只覆盖 happy path：还需证明无 token 进入 RPC、日志或 argv；API 与浏览器 URL 分别受独立 allowlist 限制；workspace/account/generation 变化不会串账号写入或污染 UI。

## 非目标

- 不实现 Review Mode、编辑器嵌入、GitLab、GHES 或自建实例；仅为后续 provider 保留结构。
- 不做 Issue 写操作、自定义查询、hover 卡片、补全、TODO→issue、suggestion 本地应用。
- 创建 PR 只接受已推送的远端分支（含 fork）；不在创建流程中 push，也不创建 fork，引导用户走现有 push RPC。
- 不接管 Git 传输认证，不把 OAuth token 桥接到 `git fetch/push`；不自动删除分支或承诺跨 ref/config 的原子回滚。
- 实施全程不操作真实凭据、真实 OAuth、远端写入或破坏性动作；依赖安装/网络访问先获批准，未获指示不提交、不推送、不发布。

## 方案

### 边界与实施落点（Planned）

沿用 [当前架构](../../architecture/overview.md)：Host 负责安全门禁、凭据运行时、REST provider、Git 集成和 `/git` RPC；Client 只接收 wire-safe 状态/结果，主 fiber 拥有全部可移植 UI。Git 继续由 `ctx.subprocess` 以分离 argv 调用，不引入 shell、Electron 或 Desktop 运行时依赖。可选 Desktop 通知在子 `ctx.inject(['desktop'], ...)` fiber 中，仅声明实际消费的结构方法。

按现有 Host 入口/服务、共享类型、`src/compat/`、Client controller/侧栏及对应测试组织实现；远程状态机与 provider 模块应独立于本地 Git 路径。稳定 RPC 契约届时在 `docs/reference/remote-platform-rpc.md` 建立唯一参考，架构文档链接而不重复其 schema。

### 阶段与验收门

| 阶段 | 前置依赖 | ADR 条款 | 退出条件 |
| --- | --- | --- | --- |
| S0 分析与计划 | 无 | 1–15 | 双语计划/索引与文档检查完成；不改变 ADR 状态 |
| S1 安全契约与 Host 边界 | S0 | 1、4、7、9、15 | 不完整 seam 明确 off；实现尚缺时完整 seam 也 off；本地 Git 零回归 |
| S2 凭据与认证运行时 | S1；依赖车道及存储保证 | 2–7 | 发现、登录/登出、刷新及卸载故障路径有确定性测试 |
| S3 中立 provider 与 REST 读取 | S2 | 7、8、10、13、15 | 有界、可取消、隔离账户的 PR/Issue 读取及权限事实 |
| S4 仓库身份与 Git 集成 | S3 的身份/快照 | 9–11、15 | checkout SHA/CAS/部分回执与 Issue 分支临时仓库测试通过 |
| S5 受保护写操作 | S2–S4 | 9、12、15 | 单快照身份核对、SHA 前置与未知结果收敛；全部写端点纳入门禁 |
| S6 可移植 Client | S1–S5 | 1、5、7、9、12、15 | PR/Issue/认证完整界面、两步确认及安全行内锚点；卸载无本地 UI 损失 |
| S7 通知与集成验收 | S1–S6 | 1、13–15 | 通知增强可卸载、完整兼容矩阵和最终验收证据；才可完成计划 |

阶段通过只表示该门完成；缺失的后续能力仍标为 Planned，不对外暴露占位 Remote UI。尤其 S1 不能将“探测到 seam”冒充“远程功能已启用”。

## 任务清单

### S0 — 分析与双语计划

- [x] 完成需求/安全边界/阶段验收分析、双语计划及两级索引；`pnpm docs:check`、`git diff --check` 均通过，证据见下方日志。保持用户已有 ADR/决策索引原样，不晋级状态。

### S1 — 安全契约与 Host 边界

- [x] 定义无 secret 字段的 capability、opaque generation、viewer、permission、action、结构化错误/回执契约；本地 credential key/ref 的语法与上游等价，构造器保留品牌类型且不引入运行时 credentials import。落在 `src/remote/types.ts`（经 `src/types.ts`/`./types` 发布）与 `src/remote/credentials.ts`；key/ref 语法与上游 `KEY_SEGMENT_PATTERN`/`REF_PATTERN` 逐字一致，`gitRemoteCredentialKey('dsh-plugin-git','github-com')` 产出 `dsh-plugin-git/github-com`。
- [x] 结构性探测 `readRecord`、`modifyRecord`、`deleteRecord`、`resolve`、`describe`、`describeRecord` 及实际 `record-updated` 事件发射面（`notifyRecordUpdated`，允许原型继承、只读不调用）；不能用通用事件 API 存在冒充该事件受支持。缺任一项整功能 off，不逐方法降级，不按版本字符串判断。落在 `probeCredentialsService`。
- [x] `/git` 的 `remote-capability` 始终返回结构化 off/reason；不可用时其他 `remote-*` 返回 `git/remote-unavailable`。即使 seam 完整，在认证/provider 运行时尚未完成时也返回 implementation-pending/off，不注册占位 Remote UI。落在 `src/remote/feature.ts` + `src/index.ts` 边界分发（remote 端点在 `record()`/仓库断言之前处理）。
- [x] capability 探测不发网络、不启动子进程，不从 `describe*` 推断已认证身份；保持旧 Host 加载路径和 Changes/Diff/Graph/Worktrees 不变。计数断言 spawn/fetch 均为零。
- [x] 定向测试逐个缺失方法/事件、secret 不泄露、探测零网络/子进程、动态 seam 消失及本地 Git 回归；同步已落地的 RPC/架构边界文档。见 `tests/remote-feature.spec.ts`、`tests/remote-endpoints.spec.ts` 与 [远程平台 RPC](../../reference/remote-platform-rpc.md)。

### S2 — 凭据与认证运行时

- [x] 使用上游类型前先补齐 `@deepseek-ai/dsh-credentials` optional peer/type-only 开发依赖及 lane-aware 安装/兼容规则；只为确实发布该包的车道声明相应范围，不强迫旧车道安装不存在的包。本地 branded 构造器保持零运行时导入；依赖一律 registry semver，禁止 `workspace:`。peer OR 只覆盖 `CREDENTIALS_SEAM_DSH_RELEASES`（`0.2.0-rc.2` 起）并标 `optional`，开发 pin `0.2.0-rc.2`；兼容门禁按该子集校验，旧车道可无该包安装。
- [x] 校验 GrantRecord v1、记录 key/ref 与 host/client/app 绑定；所有状态迁移经 `modifyRecord` mutate/CAS，每次持久提交使用不可复用 revision，不另写文件/settings/keychain。区分持久 revision 与 Host opaque `{ instanceId, revision }`；token fingerprint 仅为进程内不可逆摘要，不上 wire/日志。落在 `src/remote/grant.ts`（`parseGrantRecord`/状态 union，`dsh-plugin-git/github-com`）与 `auth.ts`（`authBase` 每次提交换 `uuid` revision、sha256 进程内 digest）。
- [x] 每次操作 resolve；发现链为 authenticated grant→`GH_TOKEN`/`GITHUB_TOKEN` refs→`gh auth token`→匿名，并如实报告 source。`gh` 仅在 seam mount、凭据事件、显式重试、401 后身份重建事件中串行执行，每事件至多一轮；401 置 invalid 并要求修复，不静默换账号，匿名仅用于从未有凭据的情形。`establish()`/`resolveContext()` 按序检查 grant→refs→缓存的 `ghToken`→anonymous；`markInvalid` 记 fingerprint 阻断同 token 复入；malformed/unsupported 记录直接 `invalid` 不回落发现。
- [x] `git credential fill` 只允许用户显式触发；凭据探针设置 `GIT_ASKPASS=''`、`GIT_TERMINAL_PROMPT=0`、`SSH_ASKPASS_REQUIRE=never`、`GCM_INTERACTIVE=never`、`-c credential.interactive=never`，硬超时 ≤5s、限制输出、错误脱敏；stdout/stderr 不透传，token 不进 argv。落在 `src/remote/probe.ts`：`git credential fill` 仅由 `useGitCredential()` 显式调用；protocol/host 经 stdin 传入；超时/取消组合经内部 AbortController，abort 时 terminate 并等待退出；输出上限 4096，失败统一为脱敏 `GitRemoteError`。
- [x] Device Flow 由 `Config.remote.clientId` 提供公共 client_id、scope 为 `repo`；先 CAS 持久化 authorizing/attemptId，再完成匹配 attemptId 的提交。覆盖 interval、slow_down、过期、拒绝、取消、重复登录互斥；缺 client_id 隐藏登录入口但保留发现。无 refresh token 的到期凭据转 reauth-required。落在 `startLogin`/`pollLogin`/`cancelLogin`；缺 `clientId` 时 `startLogin` 拒绝且 `capability().loginAvailable === false`。
- [x] sign-out 持久化 signed-out 并在重启后继续抑制发现；“清除本地授权”独立调用 `deleteRecord` 恢复发现，明确不是服务端撤销。落在 `signOut()`（CAS 写 signed-out）与 `clearLocalGrant()`（`deleteRecord`）。
- [x] 刷新 prepare 必须**先提交** refreshing/refreshId/basedOnRevision，再由 owner 在锁外发送；complete 仅在 refreshId+basedOnRevision CAS 匹配时写入新 token。旁观者有界等待后转 reauth-required，绝不补发。落在 `refresh()`：marker CAS 未命中即转 `waitRefresh` 有界等待（`refreshPollMs`/`refreshTtlMs`/`refreshExpiresAt`），settle 后采用已提交结果；prepare 提交失败在发送前抛出。
- [x] 刷新发送后超时/响应丢失/任意 5xx（含 502/504）、确定性拒绝、complete 提交失败、崩溃/重启均不重放；marker 提交后发送前崩溃也按可能已消费处理。只有传输层**确认未发送**才允许安全重试；prepare 提交失败不发送。complete 失败丢弃新 token 并报告远端已更新/本地未提交。`GitRemoteTransportNotSent`/`kind: 'not-sent'` 才走 restore（后续操作可安全重试）；其他失败 CAS 写 `reauth-required`；complete CAS/提交异常抛 `{ stage: 'complete', remoteUpdated: true, localCommitted: false }` 并保留 marker。
- [x] 自动旋转只在 backing store **正向保证跨进程互斥**时启用；不凭本地锁猜测、不发明上游方法。不支持时 capability/文档明确自动旋转不可用。`refreshStoreExclusive` 默认 false；未声明时 refresh 直接转 `reauth-required` 不发送，`automaticRefreshAvailable` 如实为 `false`。
- [x] seam 卸载停止新工作、取消并等待所有所属工作（含登录、刷新、探针），清空 viewer/权限/ETag 等账户缓存。用 fake store/clock/transport/subprocess 覆盖并发、CAS、崩溃恢复、未发送例外、secret 脱敏与卸载 drain；不调用真实 OAuth。`dispose()` 停止准入、abort 全部 controller 并 `allSettled` 在途工作；queued 工作启动前复查 disposed/aborted。见 `tests/remote-auth.spec.ts`（25 例）、`tests/remote-http.spec.ts`（12 例）、`tests/remote-probe.spec.ts`（5 例）。该引擎已随 S3–S6 接入 RPC/Client；旧宿主继续由 S1 门禁保护。

### S3 — 中立 provider 与 REST 读取

- [x] 提供中立 PR/Issue/viewer/permission/error 模型：PR 状态 open/closed/merged 并保留 raw-state，fork head/base 显式区分；支持 PR 列表/详情/文件比较/评论/线程与 Issue 列表/详情/评论读取。
- [x] GitHub REST 使用版本头、AbortSignal、单请求分页页数上限 + origin 校验游标续取（列表无总量天花板，Client 渐进流式补页）；API 与 web origins 独立。认证请求、重定向及分页 `Link` 只准入 API allowlist；浏览器 `html_url`、openExternal 与 device verification URL 只准入 HTTPS web allowlist且不带 token；`gh` 不作 REST 传输。
- [x] 每 generation 至多一次 `GET /user`，以稳定 user.id 核验身份；分别呈现 storage、auth、viewer、仓库 permissions。动作检查为 true/false/unknown（unknown 允许尝试、服务端裁决）；`canMerge` 用 push，`canClose` 用作者本人或 push，不从存储可写推导权限。
- [x] 认证 ETag 缓存按 host+viewer+repo+完整查询串隔离；账户变化全部失效。匿名只手动刷新；认证轮询 ≥60s 或遵守响应头的更严限制，处理 X-Poll-Interval/Retry-After/reset、primary/secondary rate limit 和指数退避；SSO/scope/认证错误分类可修复。
- [x] mock transport 验证恶意 redirect/Link/URL、分页截断、取消、限流、SSO、权限 unknown、跨账户缓存与 generation 失效；不访问真实 GitHub。

### S4 — 仓库身份与 Git 集成

- [x] 用机器可读 Git 输出解析 SSH/HTTPS remote，聚合 origin/upstream 的 provider/host/owner/repo；无 remote/不支持 provider 分类呈现，建立本地允许身份集合供所有目标写入断言。
- [x] checkout 前核对 payload remote/head 属于允许集合并拒绝脏工作区；fetch 到含 **base repo key** 的私有 PR ref，再核验 fetched SHA 等于 API head SHA，不符报告 head race 并刷新。
- [x] 同仓库 tracking 用 `update-ref` expected-old CAS（缺失 ref 用全零预期），有界处理已相等/已领先重试/分叉拒绝，防后台 fetch 倒退及并发创建覆盖。补 fetch 映射用追加，保留 single-branch clone 原映射；tracking 只证明核验快照而非远端最新。
- [x] 从显式 verified SHA switch/create 后配置 upstream；复用同名同 SHA 分支前补 tracking 并核验已有 upstream 匹配。同名异 SHA 拒绝并提供手动命名；fork 用 `pr-N` 且无 upstream；保留 multi-worktree 错误。成功以实际 HEAD == verified SHA 为准。
- [x] 回执区分未切换但 privateRef/trackingRef/fetchMapping 部分准备完成，与已切换的实际 HEAD/未完成 upstream；不假回滚、不自动删分支、不盲目清理。OAuth token 不进入 Git 传输；区分平台认证成功与 Git fetch 未认证。
- [x] Issue 分支复用 `createBranch`/`switchBranch`。临时仓库测试覆盖 origin/upstream 同号 PR、dirty、API SHA race、后台 fetch 前进、缺 ref 并发创建、equal/ahead/divergence、single-branch 映射、复用分支、multi-worktree、config 失败及 checkout 各阶段失败/部分回执。

### S5 — 受保护远端写入

- [x] 逐个枚举并将 PR 评论、行内评论、review、create/close/merge、PR checkout、Issue 分支等所有 remote mutator 纳入 `isRepositoryWrite`（包括 ref/config/分支写入）；列表/读取和 capability 不误标写。
- [x] 同时 `assertSessionRepository` 与断言本地允许的 remote host/owner/repo；payload 包含对象身份、`expectedGeneration`、`expectedViewer(host + stable user.id)`。逐操作 resolve 的**一份不可变凭据快照**同时用于身份检查和发送，不在检查后换 token；context 变化即拒绝并要求刷新重确认，workspace 变化取消未发送写入。
- [x] merge 将 `expectedHeadSha` 映射到 GitHub `sha`，review 将展示快照的 SHA 传为 `commit_id`；create PR 明确 fork head/base 且仅接受已推送分支。权限预检与 protection/scope 拒绝如实呈现；S6 才接入 close/merge 两步确认。
- [x] 评论、review、create/close/merge 不自动重试非幂等请求；发送后超时/取消返回 `write-result-unknown`，提供对具体对象的定向刷新对账，不能当作未发送或自动重发。
- [x] mock 测试账号切换（同 login 不同 id 亦然）、generation/仓库变化、检查后凭据变化、未发取消/已发未知、head-moved 和重复提交防护；断言实际请求 token 始终来自核对过的那份快照。

### S6 — 可移植 Client

- [x] 主 fiber 轮询 capability，动态注册/注销 `git.remote` type 和可移植 body/title；workspace/account/generation 不匹配的回复丢弃/取消。remote provider 卸载不移除本地 Changes/Diff/Graph/Worktrees，不依赖 Desktop。
- [x] 交付 PR/Issue 浏览、文件比较、评论/review、checkout、已推送分支建 PR、Issue 分支与认证修复界面；隐藏缺 client_id 的登录入口，区分 sign-out/删除本地授权以及平台/Git 传输认证。产品文案按现有 locale 机制提供中英版本。
- [x] 比较快照保留 path、base/head SHA、原始 old/new 行号及 side 锚点；行内提交用 `line/side`、多行 `start_line/start_side` 与同快照 `commit_id`，不使用 deprecated position 或从渲染行号反推。
- [x] 删除行、rename、多 hunk、多行、outdated、patch 截断或歧义无法可靠定位时，可读浏览仍可用，但可见地禁用不安全行内提交并解释原因；不扩展为 Review Mode。
- [x] close/merge 强制两步确认（沿用 discard 模式）；体现权限三态、head 变化重新确认及未知写结果的定向对账，阻止盲目重试。
- [x] Client controller/component/lifecycle 测试覆盖完整读写流、锚点、乱序回复、账号/目录变化、seam 动态卸载、定时器/订阅/请求 teardown，以及卸载后本地 UI 保留。

### S7 — 通知、兼容与集成验收

- [x] review request、自己 PR 的 merged/closed/changes-requested、push 后建 PR 建议按事件 id 去重；Web 为 tab 内徽标。Desktop 增强仅在子 fiber 调结构性 `notification.show`，移除增强时 core UI 与徽标继续工作。
- [x] 以 [兼容契约](../../reference/dsh-compatibility.md) 及其链接的唯一版本清单驱动**全部受支持精确 release 车道**，不只测最小/最新版本。保留 lane-aware optional credentials 安装；旧宿主用真实无该包安装树证明 install、bundle load 与本地 Git 均正常，而非只 mock seam 缺失。
- [x] 最小可用 seam 宿主 `0.2.0-rc.2` 与当前支持上沿 `0.2.1-rc.2` 均记录 mount/unmount、abort/drain 证据；开发 pin 与“当前上沿”不混淆。矩阵安装若需网络，先取得用户许可，不自动执行。
- [x] 每阶段落地时同步需求、架构、RPC reference、兼容契约及相应中英导航；根 `README.md`/`README.zh.md` 同步后刷新 `README.i18n.yaml` 双方 hash，必要时调整开发约束，使 Planned/Current 与真实能力一致，不能全部拖到 S7。
- [ ] 最终检查点运行完整门禁并汇总手工验收；所有实现及验收通过后才标 Completed，同时把**两份**计划移到 `completed/` 并修复索引和链接。不因 S0/S1 完成而归档，不自动接受 ADR。

## 验证

### 分层证据

| 范围 | 方法与记录要求 |
| --- | --- |
| 本次 S0 文档任务 | **只运行** `pnpm docs:check` 与 `git diff --check`，日志保存在仓库外绝对临时路径并在交接中给出；不运行 build/unit/artifact，不联网安装 |
| S1–S6 | 每阶段使用相应窄范围 Host/Client 测试、mock transport/store/clock 和临时仓库；记录具体命令、退出码、覆盖的验收门与未覆盖项 |
| S7 最终检查点 | 一次完整运行 `pnpm compat:check`、`pnpm test`、`pnpm docs:check`、`pnpm build`、`pnpm test:artifact`；完整 release 矩阵逐车道保存相同门禁证据，不用一个默认车道代替矩阵 |
| 手工/外部 | 真实 Device Flow/SSO/远端读写、Windows/Linux/Web/Desktop 验收须另有环境和用户许可；未执行写 **Not verified**，不得以 mock 或构建成功替代 |

全流程使用脱敏日志和模拟凭据；测试不操作用户凭据、真实远端写入或破坏性动作。真实 OAuth/远端写验收另行授权、隔离并记录，不能由计划勾选自动触发。

### 风险与外部前置条件

| 项目 | 处理/阻塞范围 |
| --- | --- |
| 公共 OAuth client_id 与 App Device Flow 设置 | 部署方提供并开启；未提供时隐藏登录，不能伪造可用认证 |
| backing store 跨进程互斥正向保证 | 核实实际 provider 契约/实现；无保证则自动旋转不可用且明确说明，不创造上游 API |
| GitHub rate limit、secondary limit、组织 SSO 与权限策略 | mock 先覆盖规范化错误/预算；真实行为需许可环境验证，不把 storage writable 当 auth 或权限 |
| Git fetch 认证及本地并发 | 使用用户既有 Git transport；SHA/CAS 与部分回执防并发覆盖，失败需人工可理解的修复入口 |
| 可选依赖与旧车道安装 | 更新依赖规则先于消费；网络安装必须获准，旧宿主无包证据是验收必需项 |
| GHES/自建 host-id 编码 | 明确延后，不阻塞 GitHub.com 冻结，也不顺带实现自建实例 |

实施保留在当前 `feat/git-remote` 分支；若之后获准提交，使用用户正常 Git identity，绝不加 Generator 或 Co-author 归属；未请求不 push/publish。

### 进度与验证日志

| 日期 | 阶段 | 记录 |
| --- | --- | --- |
| 2026-10-22 | S0 | 已阅读仓库规则、文档 skill/template、branch/mirror note、ADR 最终 15 条及计划索引；需求与设计按已定结论整理，双语计划/索引已写。`pnpm docs:check` 通过（55 个 Markdown、569 个链接、188 个文件名，exit 0）；`git diff --check` 通过（无输出，exit 0）。日志位于仓库外临时文件，绝对路径随交接报告提供 |
| 2026-10-22 | S1 | 落地 `src/remote/{types,credentials,feature}.ts`、`src/types.ts` 重导出、`src/index.ts` remote 边界分发与错误适配；`tests/remote-feature.spec.ts`、`tests/remote-endpoints.spec.ts` 新增。`pnpm exec vitest run tests/remote-feature.spec.ts tests/remote-endpoints.spec.ts tests/rpc-channel.spec.ts tests/host-entry.spec.ts`：4 文件 63 例全过；`pnpm build:types:standalone` exit 0；`pnpm docs:check` 与 `git diff --check` 通过；日志存仓库外临时目录（路径见交接报告） |
| 2026-10-22 | S2 | 落地 `src/remote/{settings,errors,grant,http,probe,auth}.ts`、`Config.remote` schema 与 `@deepseek-ai/dsh-credentials` optional peer（`CREDENTIALS_SEAM_DSH_RELEASES` 子集）；`tests/remote-{auth,http,probe}.spec.ts` 新增。`pnpm exec vitest run tests/remote-auth.spec.ts tests/remote-http.spec.ts tests/remote-probe.spec.ts tests/remote-feature.spec.ts tests/remote-endpoints.spec.ts tests/rpc-channel.spec.ts tests/host-entry.spec.ts`：7 文件 98 例全过；`pnpm build:types:standalone`、`pnpm compat:check`、`pnpm docs:check` 与 `git diff --check` 均 exit 0。该次阶段检查时认证引擎仍未接 RPC，capability 为 `off`；后续进展见下方续作日志。无真实 OAuth。日志存仓库外 `/tmp/dsh-git-s2/` |
| 2026-10-22 | S2–S7 续作 | 认证取消/slow_down/URL/正文超时修复；落地 `provider/github-model/github/git/runtime/diff`、RPC 接线与 Client 远程 surface/controller/通知。定向测试与类型检查已通过，主车道 43 文件 442 例通过；`compat:check`、`docs:check`、`build`、`test:artifact`（4 例）均 exit 0；17 个精确版本最终门禁全过，逐车道见下方。真实 OAuth、远端写入及跨平台手工验收 **Not verified** |
| 2026-10-22 | S3/S6 续作 | 远程列表/评论/文件读取从"预算内一次取尽 + truncated 警示"改为游标渐进流式补页：`RemotePage` 增 opaque `next`，`remote-list-*`/`remote-comments`/`remote-files` 接受 `cursor`/`pages`，Provider 校验游标 origin 且单请求页数有界；Client controller 改追加式状态、后台串行续取、按 number/id/path 去重、限流按 resetAt 有界恢复一次；`remote-files` 续页以 expected SHA 钉住比较快照；truncated 警示条移除，files 未取尽前行内评论保持禁用。通知线程展开与写路径坐标校验的有界收集不变。`pnpm test` 43 文件 448 例、`pnpm build`、`pnpm docs:check` 均 exit 0。真实远端验收仍为 **Not verified** |
| 2026-10-22 | S3/S6 续作 | PR 详情页不再主动渲染文件改动：新增 `remote-commits`/`remote-reviews` 读端点（`RemoteCommit`/`RemoteReview` 模型，`state` 归一五种），文件改动改为 `pr.url + '/files'` 的 GitHub Files 页外链按钮；commit/review 历史沿用游标流式加载，行内评论按 `reviewId` 嵌套进对应 review 只读展示；composer 移除行内提交入口（无锚点选择器），`remote-files`/`remote-inline-comment` 保留为受守护能力但 Client 不再调用。附带修复详情页 load/open 失败后的无限重试循环（按 key 记已尝试项）。`pnpm test` 43 文件 451 例、`pnpm build`、`pnpm docs:check` 均 exit 0。真实远端验收仍为 **Not verified** |

## 2026-10-22 自动验收快照

本次完整门禁为 `pnpm compat:check`、`pnpm test --maxWorkers=4`、`pnpm docs:check`、`pnpm build`、`pnpm test:artifact`，全部 exit 0。限制 worker 是为隔离多个矩阵车道的资源争用，不减少测试。此前并行不限 worker 曾触发已有 UI 规格的 5s 超时；最终车道全部复核通过。

矩阵安装由用户明确授权，在仓库外临时副本执行，原开发 pin 仍为 `0.2.0-rc.2`。本工作区仅按冻结锁文件恢复原版本安装元数据，没有升级依赖。旧车道通过 `.pnpmfile.cjs` 在安装时省略根包 optional credentials peer 的开发边，发布 manifest 保持不变；`upgrade-dsh.mjs` 同时省略相应 dev pin。registry 中部分旧版 credentials 包确实已发布，本矩阵的“无包”是明确测试条件，不是对发布时间的推断。

`remote-endpoints` 在实际各版 Cordis 下验证 seam 挂载/卸载及本地 Git 保留；auth/provider 的 mock HTTP/store 检查 abort/drain、单快照、未知写结果；临时仓库覆盖 checkout/CAS/部分回执；Client/controller/component 规格覆盖取消、旧回复、两步确认与通知增强卸载。最小 seam 及支持上沿都执行同一组规格。它们不等于真实 credentials backing store、OAuth/SSO 或远端写入验收。

| 精确 release（本次快照） | 业务/契约测试 | credentials 安装树 | 所有门禁 |
| --- | --- | --- | --- |
| `0.1.5-rc.2` | 441 通过、1 条缺席包差分跳过 | 缺席（已断言） | 通过 |
| `0.1.5-rc.3` | 441 通过、1 条缺席包差分跳过 | 缺席（已断言） | 通过 |
| `0.1.6-alpha.1` | 441 通过、1 条缺席包差分跳过 | 缺席（已断言） | 通过 |
| `0.1.6-alpha.2` | 441 通过、1 条缺席包差分跳过 | 缺席（已断言） | 通过 |
| `0.1.7-alpha.1` | 441 通过、1 条缺席包差分跳过 | 缺席（已断言） | 通过 |
| `0.1.7-alpha.2` | 441 通过、1 条缺席包差分跳过 | 缺席（已断言） | 通过 |
| `0.1.7-rc.1` | 441 通过、1 条缺席包差分跳过 | 缺席（已断言） | 通过 |
| `0.1.7-rc.2` | 441 通过、1 条缺席包差分跳过 | 缺席（已断言） | 通过 |
| `0.2.0-rc.1` | 441 通过、1 条缺席包差分跳过 | 缺席（已断言） | 通过 |
| `0.2.0-rc.2` | 442 通过 | 对应精确版本 | 通过 |
| `0.2.1-alpha.1` | 442 通过 | 对应精确版本 | 通过 |
| `0.2.1-alpha.2` | 442 通过 | 对应精确版本 | 通过 |
| `0.2.1-alpha.3` | 442 通过 | 对应精确版本 | 通过 |
| `0.2.1-alpha.4` | 442 通过 | 对应精确版本 | 通过 |
| `0.2.1-alpha.5` | 442 通过 | 对应精确版本 | 通过 |
| `0.2.1-rc.1` | 442 通过 | 对应精确版本 | 通过 |
| `0.2.1-rc.2` | 442 通过 | 对应精确版本 | 通过 |

旧车道仅跳过需要真实可选包的构造器差分测试，其余业务测试全部执行。产物检查每车道 4 例通过；无 secret 进入 RPC/argv、无 credentials 运行时导入等不变量继续生效。最终公共中立模型经 `./types` 导出，并对各车道复核类型/产物构建。

**仍未验证**：真实 Device Flow/SSO、真实远端读写、Windows/Linux/Web/Desktop 手工场景。未配置公共 client_id 时登录入口隐藏；没有 store 跨进程互斥保证时不自动旋转。计划保持 In progress，不归档、不自动接受 ADR；本轮作为一个完整提交保存；未 push、未发布。自动验收日志以 `dsh-git-remote-final` 与 `dsh-git-remote-matrix-20261022` 为临时运行标识保存于仓库外。

## 相关文档

- [ADR-0004：最终 Decision（唯一设计依据）](../../decisions/ADR-0004-remote-platform-integration.md#decision)
- [范围与需求总览（Current 基线）](../../requirements/scope-and-requirements.md)
- [当前架构总览](../../architecture/overview.md)
- [DSH 兼容契约](../../reference/dsh-compatibility.md)
- [根 README（现有能力及安装）](../../../README.zh.md)
- [文档维护规则](../../../.agent/skills/documentation/SKILL.md)
- [分支与镜像关系说明](../../../.agent/note/branch-and-mirror-layout.md)
- [计划总索引](../README.md) / [进行中索引](README.md)
