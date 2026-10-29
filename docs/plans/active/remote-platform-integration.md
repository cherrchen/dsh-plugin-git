中文 | [English](remote-platform-integration.en.md)

# Plan: 远程平台集成（ADR-0004 与 GitLab 后续扩展）

- **Status**: In progress
- **Started**: 2026-10-22
- **Completed**:

## 背景

**Current**：GitHub 远程平台实现已落地，完整外部/平台验收仍待完成；GitLab 的 GL1 实例与认证、GL2 Host 读取和 GL3 本地 Git 集成已通过自动阶段检查，GL4 受守护写与可移植 Client 已通过自动阶段检查；GL5 通知与集成验收进行中。现有本地 Git 功能及旧宿主支持仍是基线。[ADR-0004 的最终 Decision](../../decisions/ADR-0004-remote-platform-integration.md#decision) 是 S0–S7 唯一的设计依据（下文条款号均指该节），不从历史评审讨论重建决策。原 GitHub 阶段技术评审项已经闭合，但 ADR 状态仍是 **Proposed（待冻结）**；用户授权开始实施不等于自动晋级为 Accepted。

**Planned / In progress**：按 S0→S7 的依赖顺序实现完整 ADR。S0 分析/文档与 S1 安全契约/Host 边界已落地；S1 只交付 fail-closed 边界（结构化 `off` 应答与 `git/remote-unavailable` 拒绝），不能据此宣称远程功能完成。S2–S6 的认证、REST、Git 集成、受保护写与 Client 已接入，S7 通知实现已接入。完整 seam 下提供远程入口；旧宿主仍 fail-closed。阶段自动验证与完整矩阵/真实平台验收分别记录，尚未完成全部验收，不归档本计划。

**In progress（2026-10-27）**：GitLab 后续支持纳入同一 active plan 的 GL0–GL5 工作流；GL0 已冻结、ADR-0005 已 Accepted，GL1 已完成，用户已授权按顺序实施 GL2–GL5。阶段进度与验收门统一维护在下方「GitLab 后续支持与技术评审准备」，不修改 ADR-0004 对首期 GitHub 范围的历史决策，也不把原评审闭合结论套用于 GitLab。早期 GL0 检查点保留为历史记录。

**2026-10-28 独立验收：未通过。** 新增探针复现 P1 实例移除死锁与 P2 登录切换残留；GL2–GL5 不因既有自动检查通过而无条件签收。详见[本轮验收与复验门](#2026-10-28--gl2gl5-独立验收未通过)，真实平台验收仍未完成。

**最新修复复验（2026-10-28）**：A3/P1 分页 Link 不兼容已修复，原探针和真实 GitLab.com 受影响读取通过；最终代码的 18 个精确 release 门禁全部通过。当前状态以本计划下方 A3 修复复验节为准；Self-Managed 与跨平台等缺口仍未完成，GL5 不标 Completed。

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
| GitLab 后续支持（In progress） | GitLab.com 与自建 GitLab（Self-Managed）的认证、MR/Issue、checkout 与受保护写按阶段落地；不支持的动作显式禁用，真实平台验收仍待完成 | GL0–GL5 |

验收不能只覆盖 happy path：还需证明无 token 进入 RPC、日志或 argv；API 与浏览器 URL 分别受独立 allowlist 限制；workspace/account/generation 变化不会串账号写入或污染 UI。

## 非目标

- 不实现 Review Mode、编辑器嵌入或 GHES。GitLab.com 与自建 GitLab 不属于 S0–S7 首期实施范围；后续扩展仅按 GL0–GL5 的独立评审与实施门推进。
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
| S7 通知与集成验收 | S1–S6 | 1、13–15 | 通知增强可卸载、完整兼容矩阵和最终验收证据；完成 GitHub 首期验收，GitLab 扩展另见 GL0–GL5 |

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
- [x] Device Flow 由 `Config.remote.clientId` 提供公共 client_id、scope 为 `repo`；先 CAS 持久化 authorizing/attemptId，再完成匹配 attemptId 的提交。覆盖 interval、slow_down、过期、拒绝、取消、重复登录互斥；缺 client_id 时不允许启动登录但保留发现（当前 UI 保留禁用的 OAuth 选项并说明原因）。无 refresh token 的到期凭据转 reauth-required。落在 `startLogin`/`pollLogin`/`cancelLogin`；缺 `clientId` 时 `startLogin` 拒绝且 `capability().loginAvailable === false`。
- [x] sign-out 持久化 signed-out 并在重启后继续抑制发现；“清除本地授权”独立调用 `deleteRecord` 恢复发现，明确不是服务端撤销。落在 `signOut()`（CAS 写 signed-out）与 `clearLocalGrant()`（`deleteRecord`）。
- [x] 刷新 prepare 必须**先提交** refreshing/refreshId/basedOnRevision，再由 owner 在锁外发送；complete 仅在 refreshId+basedOnRevision CAS 匹配时写入新 token。旁观者有界等待后转 reauth-required，绝不补发。落在 `refresh()`：marker CAS 未命中即转 `waitRefresh` 有界等待（`refreshPollMs`/`refreshTtlMs`/`refreshExpiresAt`），settle 后采用已提交结果；prepare 提交失败在发送前抛出。
- [x] 刷新发送后超时/响应丢失/任意 5xx（含 502/504）、确定性拒绝、complete 提交失败、崩溃/重启均不重放；marker 提交后发送前崩溃也按可能已消费处理。只有传输层**确认未发送**才允许安全重试；prepare 提交失败不发送。complete 失败丢弃新 token 并报告远端已更新/本地未提交。`GitRemoteTransportNotSent`/`kind: 'not-sent'` 才走 restore（后续操作可安全重试）；其他失败 CAS 写 `reauth-required`；complete CAS/提交异常抛 `{ stage: 'complete', remoteUpdated: true, localCommitted: false }` 并保留 marker。
- [x] 自动旋转只在 backing store **正向保证跨进程互斥**时启用；不凭本地锁猜测、不发明上游方法。不支持时 capability/文档明确自动旋转不可用。`refreshStoreExclusive` 默认 false；未声明时 refresh 直接转 `reauth-required` 不发送，`automaticRefreshAvailable` 如实为 `false`。
- [x] seam 卸载停止新工作、取消并等待所有所属工作（含登录、刷新、探针），清空 viewer/权限/ETag 等账户缓存。用 fake store/clock/transport/subprocess 覆盖并发、CAS、崩溃恢复、未发送例外、secret 脱敏与卸载 drain；不调用真实 OAuth。`dispose()` 停止准入、abort 全部 controller 并 `allSettled` 在途工作；queued 工作启动前复查 disposed/aborted。见 `tests/remote-auth.spec.ts`（25 例）、`tests/remote-http.spec.ts`（12 例）、`tests/remote-probe.spec.ts`（5 例）。该引擎已随 S3–S6 接入 RPC/Client；旧宿主继续由 S1 门禁保护。

### S3 — 中立 provider 与 REST 读取

- [x] 提供中立 PR/Issue/viewer/permission/error 模型：PR 状态 open/closed/merged 并保留 raw-state，fork head/base 显式区分；支持 PR 列表/详情/文件比较/评论/线程与 Issue 列表/详情/评论读取。
- [x] GitHub REST 使用版本头、AbortSignal、单请求分页页数上限 + origin 校验游标续取（列表无总量天花板，Client 渐进流式补页）；API 与 web origins 独立。认证请求、重定向及分页 `Link` 只准入 API allowlist；浏览器 `html_url`、openExternal 与 device verification URL 只准入 HTTPS web allowlist且不带 token；`gh` 不作 REST 传输。
- [x] 每 generation 复用成功的 `GET /user`，以稳定 user.id 核验身份；失败恢复规则见 [RPC 读取契约](../../reference/remote-platform-rpc.md#仓库与读取)。分别呈现 storage、auth、viewer、仓库 permissions。动作检查为 true/false/unknown（unknown 允许尝试、服务端裁决）；`canMerge` 用 push，`canClose` 用作者本人或 push，不从存储可写推导权限。
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
- [ ] 最终检查点运行完整门禁并汇总手工验收；S7 与已确认纳入的 GL 阶段全部实现及验收通过后才标 Completed，同时把**两份**计划移到 `completed/` 并修复索引和链接。不因 S0/S1 完成而归档，不自动接受 ADR。

## GitLab 后续支持与技术评审准备

**历史检查点（GL0）**：以下 GL0 状态、授权、候选结构与评审输入记录当时的真实背景；最新阶段状态以本节末尾的 Current 记录为准。

- **Status**: GL0设计已冻结（2026-10-27）；B1复审及B2–B4限定证据完成，ADR-0005 Accepted；GL1–GL5未开始。
- **本轮授权边界**：用户已追加授权B2–B4隔离补证和最终冻结，准许使用全新真实store/一次性GitLab合成fixture；不访问用户凭据或项目。不得据此修改产品运行时代码、RPC/schema、依赖或启用GitLab；GL1仍须另获开始实施的指示。
- **设计关系**：沿用 ADR-0004 的可移植性、credentials seam 硬门禁、身份/generation 绑定、origin 校验和未知写结果原则；GitLab认证与动作语义以ADR-0005及冻结设计为目标，不能照搬 GitHub 细节。长期架构选择按 documentation skill 记录后续 ADR 并关联 ADR-0004，不重写其首期决策或自动改为 Accepted。本节维护评审处置与进度；具体冻结候选统一由[多实例与协议设计稿](../../architecture/remote-platform-instances.md)维护，均非稳定 RPC 契约。

### 主结构：统一接口、平台适配器与实例上下文（Target）

**来源与状态**：2026-10-27 用户提出并指定本方案为技术评审的**候选主结构**：业务服务只调用接口层的统一 API，再由各平台封装实现完成实际操作。GL0评审及最终冻结采纳interface +组合为主结构，ADR-0005 Accepted；这仍不是实施授权。

```text
Remote 业务服务 / runtime
  └─ 统一 RemoteProvider 操作接口
       ├─ GitHubProvider ─ GitHub 实例配置 + 独立认证上下文
       └─ GitLabProvider ─ GitLab.com / 自建实例配置 + 各自独立认证上下文
```

图为已冻结目标结构；按用户 2026-10-27 的范围调整，GitLab.com 与自建 GitLab（Self-Managed）一并进入本轮 GL0–GL5 候选交付范围，共用平台适配器并按实例隔离上下文；设计已通过，尚未开始实现。

| 层次 / 组件 | 候选职责与依赖边界 |
| --- | --- |
| 业务服务 / runtime | 依赖统一操作接口，编排会话/仓库断言、取消与本地 Git 流程；不直接构造具体平台实现、不拼平台 REST 路径。Git 命令仍由现有 Git 集成通过 `ctx.subprocess` 分离 argv 执行 |
| 统一接口与中立模型 | 定义读取、写入、结果、错误及逐操作能力；区分动作不支持与权限 unknown，不强行抹平 PR/MR、审批和讨论语义 |
| 平台适配器 | `GitHubProvider` / `GitLabProvider` 封装各自的 API 路径、参数、响应和语义映射。可类比 Python 抽象基类及子类；本轮选择TypeScript interface +组合；基类仅在已验证的共同流程中另行评估 |
| 实例配置与认证上下文 | 平台类型与 origin 分离；GitLab.com 和自建 GitLab 默认复用 GitLab 适配器，以实例配置表达 API/web origin、App 与能力。各实例隔离 grant、viewer、generation、缓存和在途任务；origin 须明确校验，不接受任意 RPC 输入成为认证目标 |
| 工厂 / 注册表与公共机制 | 由装配边界按已校验的仓库/实例选择并注入接口实现，业务服务不维护平台分支。HTTP、凭据存储、取消、预算等机制优先组合复用；只有已验证的共同流程才考虑抽象基类，避免基类堆积平台条件判断 |

**与现状的差异与评审对照**：当前已有 `RemoteProvider`，但 runtime 直接持有 `GitHubProvider`，仓库类型、认证与 HTTP 仍限定 GitHub；候选主结构需完成依赖倒置和平台/实例分离。GL0 对照“在业务层持续增加平台分支”与“以继承层级集中共享流程”两种备选，评估兼容成本、隔离、可测试性及能力差异，记录取舍后才冻结。不是每个 origin 都建子类；仅在存在实际协议/行为差异时评估专门适配器。

### 拟议范围与交付顺序（待评审）

**本轮候选交付范围调整为 GitLab.com + 自建 GitLab（Self-Managed）**，包含显式配置的 HTTPS 域名/IP、非默认端口及部署前缀。支持版本、认证方法和逐动作能力必须在 GL0 按证据冻结，不承诺所有历史版本或定制分支。Dedicated、GHES、多账号选择器和跨 provider 仓库聚合仍延后；多实例配置与实例间安全切换属于本轮。同一会话切换 GitHub/GitLab.com/自建实例时，授权记录、状态、缓存和退出行为必须隔离。

| 能力 | 拟议交付与限制 |
| --- | --- |
| 自建实例配置 | 显式登记实例 URL、API/web 基址、SSH remote 映射与 App；复用 GitLabProvider，支持配置增删改及多实例选择；不在设置中存 token，不自动扫描实例 |
| 连接与身份 | 每个 GitLab 实例独立认证上下文、连接状态与修复入口；无可用 OAuth App 配置时隐藏对应登录方法。候选发现来源须先冻结，不复用 GitHub token/client_id |
| MR / Issue 读取 | MR 列表/详情、提交、讨论/审批时间线；Issue 列表/详情/评论只读；保留渐进分页、取消和限流退避 |
| Git 集成 | MR checkout 与 Issue 开分支复用 SHA 核验、tracking CAS、部分完成回执；平台 token 不进入 Git 传输 |
| 远端写入 | MR 评论、创建、关闭、合并，以及有真实等价契约的审批动作；仅针对已推送分支建 MR，不 push、不建 fork；动作逐项通过评审与守护后才开放 |
| UI / 通知 | MR 术语、中英文案、provider 提供的网页/Changes 链接；讨论按真实来源呈现。通知逐类核对数据来源与去重，无法支持的事件显式列为延后 |
| 暂不扩展 | Review Mode、本地内嵌 diff、行内评论提交、Issue 写入、discussion resolve/suggestion 应用；GitHub 当前行内只读/网页比较边界继续适用 |

### 自建 GitLab 本轮纳入项（Proposed）

本节将自建实例从“仅结构预留”调整为本轮候选交付，按以下具体边界评审。不能以“支持配置 origin”代替可验收的自建支持。

| 纳入项 | 设计与验收要求 |
| --- | --- |
| 实例 URL 与部署前缀 | 显式配置 HTTPS 基址、非默认端口、可选部署前缀；内网域名/IP 可以作为用户配置的目标，不从 remote/响应自动信任。统一规范化协议/主机/默认端口/尾斜杠，保留路径大小写；拒绝 userinfo、query/fragment、路径逃逸与歧义编码；前缀路由覆盖 API/OAuth/web 链接。官方[相对 URL 部署说明](https://docs.gitlab.com/omnibus/settings/configuration/#configure-a-relative-url-for-gitlab)将此模式列为 Beta，须单独记录验证结果 |
| 身份与凭据寻址 | 实例身份至少区分协议、主机、有效端口及部署前缀；冻结符合 credentials key 语法的 host-id 编码与冲突处理。同域不同端口/前缀、相同 user id/project id/iid 也不共享授权或缓存；改址不能自动搬运 token，删除/修改实例取消旧请求并失效确认与游标 |
| 实例认证 | 每实例使用对应 App/client_id 和 scope，按[官方 App 配置](https://docs.gitlab.com/integration/oauth_provider/)核实注册前置；GitLab.com App 不自动用于自建实例。评审 Device Flow 实际可用性以及无 App/不支持 flow 时经 credentials seam refs 提供已有 token 的路径；不回退跨 host 的环境变量或 CLI 账号，不将 token/secret 写入设置 |
| 网络与信任 | 只向已登记实例的 API/OAuth 范围发送相应凭据，redirect/Link/web/avatar 等各按用途校验；不得用页面或仓库输入扩大信任。HTTPS 证书必须被 Host 运行时信任；企业 CA 配置途径与代理适配在 GL0 核实，不关闭 TLS 校验、不引入 Desktop 依赖；明文 HTTP 与忽略证书错误暂不纳入 |
| Git remote 映射 | 分别建模 HTTPS API/web 地址与 Git SSH endpoint（主机、端口和仓库路径）；标准 HTTPS/SSH remote 匹配显式实例，SSH 别名或反代端点差异需显式映射并校验唯一归属，不能据此推断新 API origin。Git 传输继续使用既有 Git 凭据 |
| 服务端版本与能力 | GL0 冻结最低/目标支持版本及能力表，覆盖 Device Flow 缺席、App 缺失、权限/tier/项目策略、接口字段或限流差异；不把 Device Flow 的版本记录当成全部 REST 能力保证。不支持动作显式禁用；无可用认证方法时清楚给出修复路径 |

**验收矩阵**：GitLab.com 基线、自建独立 HTTPS 域名、自建内网目标、非默认端口、带部署前缀，以及两个自建实例具有相同对象/用户 id 的隔离场景均纳入自动化 mock/fixture；临时仓库覆盖 HTTPS/SSH 映射。按用户最新补充，服务端矩阵以官方常规部署与最新稳定大版本为首要场景，保留自定义配置及缺失认证/动作能力负向；本次精确检查点以候选稿 D8 为准，较老大版本兼容另行验证。真实验收需用户提供或授权的隔离测试实例、实际版本、可信 TLS、App/token 与网络可达性；本轮不要求生产账号，不自动部署服务器或访问用户内网。缺少环境时相关真实场景保持 **Not verified**，不声称自建支持已完成。

### GL0 历史代码差距（2026-10-27 核对）

以下是评审输入，不是已实施的改造：

| 落点 | 已核实的 GitHub 耦合 | 评审需给出的输出 |
| --- | --- | --- |
| `src/remote/provider.ts`、`types.ts`、`runtime.ts` | `RemoteRepository` 的 provider/host 为 GitHub 字面量；runtime 直接构造 `GitHubProvider`，认证 RPC 没有 provider 选择上下文 | provider/host 寻址、实例生命周期和兼容迁移方案，保持现有 GitHub 调用可用 |
| `auth.ts`、`grant.ts`、`probe.ts`、`settings.ts` | grant key/host、`gh` 与 helper 目标、登录路径/client_id 都围绕 GitHub | 每 provider 的 grant/ref/App 绑定、认证方法与探针预算；GitHub 旧记录不迁移到 GitLab |
| `http.ts`、`github-model.ts`、`git.ts` | 固定 origin/OAuth 路径，GitHub owner/repo 校验与 remote 解析；Git 集成直接依赖 GitHub 校验器 | REST/OAuth 路径边界、多级 namespace 与项目身份规范、独立校验器/共享工具边界 |
| `src/client/remote.ts`、`src/client/remote/` | 缓存键使用 owner/repo；review 事件为 GitHub 集合，网页比较、头像和正文处理有 GitHub 专用逻辑 | provider 能力/术语/链接投影、缓存隔离、头像/Markdown 安全策略；不让 GitLab 假扮 GitHub review |

### GL0 技术评审议题与证据

官方资料核对日期为 **2026-10-27**；未使用真实账号。下表的“建议”均为 Proposed，证据链接用于下一轮复核；API 可用不等于当前插件已支持。优先级 P1 表示对应设计未闭合前禁止启用，P2 需明确交付或延后。下表为初始评审输入；当前处置和未闭合冻结项以下方「GL0 评审结论与处置」为准。

| 编号 / 优先级 | 已知事实与候选方案 | 待决问题及退出证据 |
| --- | --- | --- |
| GL-R0 / P1 · 候选主结构与依赖边界 | 以上述用户指定的统一接口 + 平台适配器 + 实例配置 + 独立认证上下文作为评审主方案 | 明确装配/选择、实例身份与生命周期、接口/能力边界及 GitHub 旧设置/RPC 兼容迁移；给出可替换 provider 的契约测试、多实例隔离、未知平台/origin 拒绝用例，说明 interface 与抽象基类/组合的取舍，本轮不实现 |
| GL-R1 / P1 · 认证与 scope | 官方 [OAuth API](https://docs.gitlab.com/api/oauth2/#device-authorization-grant-flow) 提供 Device Grant，端点为 `/oauth/authorize_device` 与 `/oauth/token`；专节记载 17.9 GA，不把概述中的版本简写当兼容基线。建议评估 Device Flow；PKCE 为备选 | 核实公共/非 confidential App 注册、无需内嵌 secret 的交换/刷新、部署方 client_id 与最小 scope。按[认证文档](https://docs.gitlab.com/api/rest/authentication/)核对只读与写权限；grant→GitLab refs→可选 `glab`→匿名只是候选链，明确 ref 名称、来源、失败规则和 CLI 缺席行为；不自动调用交互式 CLI 登录 |
| GL-R2 / P1 · 凭据生命周期与隔离 | GitLab.com 候选使用独立 `gitlab-com` grant key；自建实例需规范化 URL 身份与可区分的 host-id/key，并绑定 provider/实例/App 上下文；沿用 ADR-0004 两阶段刷新、signed-out 抑制发现和 invalid 不换身份规则 | 冻结设置兼容方案与记录校验；证明任一 GitLab 实例登录/退出/401/刷新/卸载不会触碰 GitHub 或其他 GitLab 实例的 grant、viewer 或在途操作。无 backing-store 跨进程互斥保证时继续禁用自动旋转；补 fake store/CAS/取消/崩溃矩阵 |
| GL-R3 / P1 · 项目与对象身份 | [REST 参考](https://docs.gitlab.com/api/rest/#id-vs-iid)区分全局 id、项目内 iid，并要求 namespace 路径编码。候选身份含完整 namespace/path，解析后绑定服务端 project id | 决定 owner/repo 是否可兼容表达 subgroup，不能截成两段；冻结大小写/编码/改名或迁移策略、source/target project 与 fork 绑定、origin/upstream 集合及同 iid 隔离；明确 open/closed/merged + rawState 与列表筛选映射。路径解析和 RPC 输入不能扩大允许仓库集合 |
| GL-R4 / P1 · 传输、分页与能力 | 建议 GitLab.com 使用固定 origin，自建实例使用显式配置并校验的 HTTPS 基址；REST 限部署前缀下 `/api/v4/`，OAuth 单独准入；即使 API/web 同 origin，也须按用途校验路径。[分页规范](https://docs.gitlab.com/api/rest/#pagination)要求按端点适配续页 | 冻结 token header、redirect/Link/游标校验、预算/缓存与限流分类；不照搬 GitHub 版本头和限流假设。区分“不支持动作”（禁用）与“权限 unknown”（服务端裁决），不能因 unknown 就开放未实现写入；mock 恶意路径、跨 provider 游标及相同 user id/cache key |
| GL-R5 / P1 · 审批与讨论语义 | GitHub review 三态不是 GitLab 的现成统一事务。[Approvals API](https://docs.gitlab.com/api/merge_request_approvals/#approve-merge-request)支持带 SHA 审批；[Discussions API](https://docs.gitlab.com/api/discussions/#merge-requests)提供 notes/线程与独立 diff position | 逐项决定 approve/comment/request-changes 的真实映射、tier/策略前置及时间线投影；没有可靠等价契约的动作禁用并说明。不伪造 review 历史或静默把 request-changes 降为普通评论；正文评论与审批若需两次请求，明确部分成功，不宣称原子提交；本阶段行内只读 |
| GL-R6 / P1 · 写入与合并策略 | [MR API](https://docs.gitlab.com/api/merge_requests/#merge-a-merge-request)的 merge 支持 SHA 前置。建议保留 expectedGeneration/viewer、仓库断言、两步确认与未知结果对账 | 冻结逐端点 create/comment/close/approve/merge 映射、source/target project、draft 与动作权限；GitHub merge/squash/rebase 选项不能原样承诺。区分项目策略、排队/自动合并、已完成合并；无服务端 SHA 前置的写操作明确竞态保证边界，不用客户端预读伪装原子性；非幂等写不自动重试 |
| GL-R7 / P1 · Checkout 与本地安全 | 官方[本地 checkout 指南](https://docs.gitlab.com/user/project/merge_requests/merge_request_troubleshooting/#check-out-merge-requests-locally-through-the-head-ref)给出 `refs/merge-requests/:iid/head`。候选沿用私有 ref→SHA 核验→tracking CAS→switch/upstream 的顺序 | 明确 target project/MR iid 私有 ref 命名、fork/已删除 source branch、远端 ref 缺失、同名分支与 API/ref race；临时仓库验证部分回执、single-branch clone、并发 fetch/worktree 和 dirty 拒绝，token 不进 argv/helper 写入 |
| GL-R8 / P2 · Client、通知与回归 | 复用当前主 fiber/可卸载 Desktop 子 fiber；GitLab 使用 MR 和自身网页链接，[Notes API](https://docs.gitlab.com/api/notes/)与讨论来源须去重 | 给出每项 UI 动作的 enabled/disabled/unknown 表；讨论/系统事件/审批无重复时间线，头像与正文 URL 安全。冻结 review-requested/merged/closed/changes-requested 通知的数据源，无法可靠映射则列为延后；跨仓库切换、provider 卸载不损害 GitHub/本地 UI |
| GL-R9 / P1 · 自建实例交付边界 | 按上节自建纳入项将 Self-Managed 放入本轮候选交付，共用 GitLabProvider、隔离实例上下文 | 冻结 URL/端口/前缀/host-id 与 SSH 映射、TLS/企业 CA/代理前置、逐实例 App/ref 发现、服务端版本/能力矩阵、配置变更/卸载隔离及真实实例验收；同域不同端口/前缀、跨实例 redirect/游标与相同对象 id 不得泄露凭据或串实例写入 |

### GL0 评审结论与处置（2026-10-27，Conditional GO）

**输入**：用户提供的《GL0 技术评审报告：GitLab 支持（GitLab.com + Self-Managed）》，工作分支 `feat/remote-gitlab`。现有 0.2.8 RPC/导出类型按已发布契约保护；对照当前代码和本节链接的官方资料复核，未使用真实账号/实例、未执行远端写入。报告结论为“需修订后可实施”；本节接收该结论，**采纳统一接口 + 组合 + 平台适配器 + 实例上下文作为修订主方案**，不把报告中的所有细节自动视为已冻结事实。

上方 GL-R0–R9 表保留原始议题与验收要求；本节是本轮评审处置和后续冻结状态的唯一真源。处置人：当前文档维护 Agent；后续实施者负责附上实现证据。**Conditional GO 不等于 GO；所有 P1 冻结项仍需逐项闭合，GL1–GL5 未启动，ADR-0004 状态不变。**

**处置记录复审**（用户报告，2026-10-27）：通过，记录本身无阻塞项。F1 已按实际工作分支修正为 `feat/remote-gitlab`；可选 F2 已在 GL-R8 与冻结清单中显式命名 Markdown 渲染变体。该结论仅确认记录可进入冻结阶段，不代表剩余 P1 闭合、GL0 已冻结或 GL1 启动。

| 议题 | 报告意见的处理 | 冻结状态 / 退出证据 |
| --- | --- | --- |
| GL-R0 | 采纳 interface + 组合与实例注册表；认证/HTTP 差异注入描述参数，业务层不添加平台分支。认证/能力 RPC 增加实例作用域，旧无作用域调用继续指 GitHub；关联 GL-R10 | 需修订冻结：完整请求/响应示例、旧调用/旧 Client 行为、跨实例切换和可替换 provider 契约用例 |
| GL-R1 | 采纳 Device Flow 主路径、写操作所需 `api` scope 候选、每实例 App、无 App 隐藏登录和验证后的 CLI 来源；PKCE 暂不纳入本轮。refresh token 同时设计有/无两条路径，关联 GL-R11 | 双路径设计可替代“必须先实测才有设计”的阻塞；真实签发行为仍 Not verified。ref 来源不能直接等同 PAT 类型；CLI 帮助文本/多行输出/0 退出码须有负向用例，`GET /user` 验证失败不接受身份 |
| GL-R2 | 采纳每实例 grant、App 绑定、CAS/两阶段刷新/退出隔离；拒绝“hash8 保证无碰撞”表述 | host-id 候选改为规范 URL UTF-8 的无填充小写 base32 加 `gl-`（可逆，符合 key 字符集），GitLab.com 固定 `gitlab-com`；冻结长度/URL 上限和旧 GitHub key 保留规则后才能闭合，不静默截断或复用冲突记录 |
| GL-R3 | 采纳完整 path + 解析绑定 projectId + iid；当前 owner 校验不接受 subgroup，需演进。新增 instance/path/projectId，不删除旧 GitHub host/owner/repo 字段，不改旧字段含义 | 冻结新旧身份转换、实例+projectId 与本地 remote 绑定、项目迁移/改名重验证。报告的 `locked → open` 与 ADR 历史 `locked → closed` 不同，须显式形成后续决策，期间 rawState 保留、禁止合并；混合 provider remote 的本轮准入也须单列范围决策 |
| GL-R4 | 采纳实例 base+用途/路径校验、分页隔离、机会性 ETag 与 ≥60s 轮询预算；版本元数据仅作线索。动作支持状态关联 GL-R12 | 冻结 role/path 精确表、缓存/游标、版本/能力缺失时行为；不能把版本号、Enterprise 标志或 plan 当成动作授权证明，也不能在 capability 探测中新增网络请求 |
| GL-R5 | 采纳审批/正文多请求的部分成功语义及 discussion 原始模型；不把审批快照伪造成历史，不把 thread id 塞进旧 reviewId | `REQUEST_CHANGES` 提交暂延后并显式不支持，除非补齐公开写端点/版本证据；读取可保留已证实的原值。需冻结新增 thread/discussion 字段、可靠事件来源与双坐标/多行/outdated 规则；歧义只读，不构造伪锚点 |
| GL-R6 | 采纳 SHA merge、按 provider 协商 merge 方法、close/comment/create 无原子 SHA 前置的诚实边界；本轮暂延后 auto-merge/merge train 排队与独立 rebase 操作 | 冻结直接合并和多步骤回执、逐动作权限证据；不能仅凭 access level 阈值把 canMerge/canClose/canComment 判 true，缺少目标分支/对象/策略证据用 unknown，已知禁止则 false |
| GL-R7 | 采纳目标项目 MR head ref、SHA/CAS/部分回执与实例+项目私有 ref 隔离；缺失 ref 如实报错，不能把所有 fetch 失败断言为“已清理” | 冻结 SSH/HTTPS 唯一匹配、MR 分支命名与相对 URL 的 SSH 路径验证；源分支 fallback 只有显式绑定允许 remote、仍核验同一 SHA 且不扩大允许集合时才可纳入，否则延后 |
| GL-R8 | 纳入 MR 术语、页面链接、安全头像/正文、Markdown 渲染变体决策、可验证的审批/讨论读取和 review-requested 候选通知；`REQUEST_CHANGES` 提交按 GL-R5 延后 | `/todos` 只作通知候选来源，不承诺覆盖所有“自己 MR merged/closed/changes-requested”；每种事件冻结覆盖范围/补充查询/去重，不可靠则明确延后；UI 不因旧 `!== false` 判断开放新不支持动作；明确 `github-markdown.ts` 的 provider 变体或经验证共享子集方案，并为 GitLab 特有标记与 HTML/链接安全提供 fixture，作为 GL4 退出证据 |
| GL-R9 | 采纳显式实例配置、HTTPS/部署前缀、逐实例上下文与真实验收矩阵；关联 GL-R13 | 冻结 `{url,sshHost,sshPort?,clientId?,id?}` 的默认值/唯一性/可编辑 id 含义，不允许 display id 改变安全身份。HTTPS 与 SSH 各自按协议匹配登记映射，不要求一条 remote 同时符合两种语法；TLS 依赖 Host 信任链，代理按运行时版本验证 |

**新增议题跟踪**（保留报告编号，不复用；均未自动闭合）：

| 议题 | 优先级 / 归属 | 处置与冻结要求 |
| --- | --- | --- |
| GL-R10 · 多实例 capability | P1 / GL-R0 | 选择按 `{provider,instance}` 定位的修订主方案；无作用域保持现有 GitHub 行为，seam 级 off 不变；未知/删除实例与登录失败不得关闭其他实例 UI。逐实例状态仅从已知内存/存储读取，版本/身份 REST 在显式初始化读取路径完成 |
| GL-R11 · Device Grant refresh token | P1 / GL-R1 | 不猜官方示例遗漏意味着不签发。实际存在 refreshToken 且 store 互斥保证成立时才报告可自动刷新；无 refreshToken 按实际 expires_in 到期要求重新认证，不固定假设 2 小时，不把 PAT 包装成 OAuth grant；两条路径、缺 expires_in 和持久化故障均需设计/测试 |
| GL-R12 · 动作支持与方法集 | P1 / GL-R4、GL-R5、GL-R6 | 不能直接给旧 action 字段加字符串第四态：当前 Client 仅禁用 false。候选为保留三态字段（不支持写 false），新增支持信息/原因、merge 方法集和 review 事件集；若选新枚举必须有显式契约协商/版本隔离和旧 Client 测试 |
| GL-R13 · 未登记实例分类 | P2 / GL-R9 | 采纳登记修复入口方向；优先保持旧 supported/no-remotes/unsupported 枚举，增加可选原因/候选提示，或协商新响应形态。不对任意陌生域名猜测 GitLab 品牌，不靠一次自动网络探测建立信任 |

**复核修正与证据限制**：

- `GitRemoteGeneration.instanceId` 当前是 Host 运行时随机标识，不是规范实例 URL；继续保留。新实例身份使用新增字段显式绑定请求、viewer、generation、去重和缓存；旧 `viewer.host` / `expectedViewer.host` / grant v1 host / `reviewId` 不改义。GrantRecord 若采用新形态需版本化解析；旧 GitHub v1 读写与 key 原样兼容。新增字段也必须有默认值和旧输入兼容用例，不能仅因“additive”便宣布兼容。
- [Discussions 官方说明](https://docs.gitlab.com/api/discussions/#create-a-new-thread-in-the-merge-request-diff)允许未变行同时包含 old_line/new_line，因此不能采用“old_line 存在即 LEFT”；保留 old/new/path/base/start/head 原值，按已验证 diff 锚点投影。discussion 线程与 review 事件用不同标识；仅凭 head SHA 不同不能伪装可靠行定位。
- [受保护分支策略](https://docs.gitlab.com/user/project/repository/branches/protected/)约束可合并者；角色级别、mergeability 和当前用户权限分开处理。审批需要重新认证或强制 SAML 的限制按[审批 API](https://docs.gitlab.com/api/merge_request_approvals/#approve-merge-request)呈现为动作/方法限制，不能将整个 canReview 一概视为平台不支持。
- [MR API](https://docs.gitlab.com/api/merge_requests/)的有效状态值为 `requested_changes`，不是报告通知段的 `requested_changed`；[review 文档](https://docs.gitlab.com/user/project/merge_requests/reviews/#prevent-merge-when-you-request-changes)给出 tier/flag 演进，不能由“16.x 起存在”推出全部版本 REST 可写。[To-Do API](https://docs.gitlab.com/api/todos/)不是完整 MR 生命周期事件流；审批快照和自然语言 system note 也不是稳定完整历史契约。
- [Metadata API](https://docs.gitlab.com/api/metadata/)的 plan 字段有自己的引入版本，缺字段/null 不证明实例免费或动作可用；最低支持版本和按功能版本表仍须逐端点补证，不能直接采纳报告列出的所有版本号。GitLab.com 同样存在 schema/tier/策略演进，需要验证。
- OAuth 的 body token 只进入精确准入的交换/刷新端点；浏览器 verification URI、含 user_code 的允许 query 与 API bearer 请求分别校验，不能把 `/oauth/device` 网页纳入携带认证头的通用 OAuth 通路。自建 refs/CLI/helper 必须证明实例（含端口/前缀）绑定，无法区分则禁用该来源，不消费其他实例 token。
- [Node 代理机制](https://nodejs.org/api/http.html#built-in-proxy-support)随运行时版本和启动配置变化；不笼统冻结“Node fetch 不支持代理”，也不承诺本包最低 Node 自动读 HTTP_PROXY。记录验证过的运行时/代理设置；不修改进程全局 dispatcher、关闭 TLS 或加入 Desktop 依赖。相对 URL 的 SSH 路径仍待隔离 fixture/实例证据。

**GL1 前冻结清单**（2026-10-27 最终设计冻结；证据和未实现边界见本节下方B2–B4）：

- [x] GL-R0/R10：实例注册表、无作用域 GitHub 兼容、多实例 capability/auth RPC 与取消/卸载完整示例。
- [x] GL-R2/R3/R9：URL 规范化、host-id 可逆编码与长度上限、projectId/remote 绑定、旧 grant/wire 字段语义兼容；明确 generation 随机 id 与实例 URL 的区别。
- [x] GL-R1/R11：每实例 App、api scope、refs/CLI/helper、验证 URI 及有/无 refresh token 的双路径设计；实测未执行仍 Not verified。
- [x] GL-R4/R12：三态兼容与动作支持/方法集扩展、精确 API/OAuth/web 策略、逐端点服务端版本证据与权限 unknown 规则。
- [x] GL-R5/R6：thread/review/双坐标模型、审批正文多请求回执、直接 merge/close 竞态边界；正式记录 request-changes 写、auto-merge/rebase 延后，不把读侧也一起禁用。
- [x] GL-R7/R9：HTTPS/SSH 映射、部署前缀、旧 head ref 缺失与允许集合内 fallback/延后决策、TLS/代理验收前置。
- [x] GL-R8/R13：各类通知覆盖、时间线可信来源、Markdown 渲染的 provider 变体或经验证共享子集、未登记实例修复与旧枚举兼容；逐项明确纳入或延后。
- [x] 汇总完整请求/响应、配置、能力与版本/实例矩阵及测试清单，按 documentation skill 形成后续设计依据/ADR；所有 P1 闭合并另获明确实施指示后才进入 GL1。

### GL0 冻结准备材料包（2026-10-27）

**准备时检查点（历史；最终状态以本页B2–B4为准）**。

**本轮交付**：[GitLab 多实例与 Remote 协议演进候选稿](../../architecture/remote-platform-instances.md)（Proposed）集中维护具体配置、协议示例、结构和用例。本计划继续唯一维护评审处置与阶段状态；当前 RPC reference 和 ADR-0004 均不改义。材料已准备不等于设计已冻结，下面对应的 P1 清单仍未勾选。

用户指定默认考虑官方常规部署与最新稳定大版本，具体参数由产品用户配置；本次版本检查点和精确 patch 来源见候选稿 D8。较老大版本兼容不预先承诺；旧计划中“最低版+较新版”的初始矩阵要求按此范围调整，不影响既有 DSH 全精确 release 矩阵。

| 冻结组 | 具体候选材料 | 准备状态 / 尚需证据 |
| --- | --- | --- |
| GL-R0/R10 | D1/D3：interface + 组合、实例 registry、v2宣告及逐应答 scope 回显、旧/新 Host/Client 矩阵 | 材料已备；协议复审待通过，不能忽略旧 Host 吞 payload 的风险 |
| GL-R2/R3/R9 | D2/D4：配置示例、URL算法/512-byte上限、base32/key样例、v1适配与v2实例/project/viewer/grant | 材料已备；实际 store 最大key承载与身份/locked决策待复核 |
| GL-R1/R11 | D4/D5：逐实例ref/App、限定CLI来源、精确OAuth路径、有/无refresh token双路径 | 材料已备；真实签发未实测，不把匿名来源或ref等同PAT |
| GL-R4/R12 | D3/D5/D6：三态保留、额外支持信息、方法/事件集、单快照/权限与partial/unknown回执 | 材料已备；逐端点版本与Host/Client兼容证据待验证 |
| GL-R5/R6 | D6/D7：thread/review分离、原始双坐标、直接merge、审批多请求、延后动作 | 材料已备；作为候选取舍复审，不自动关闭P1 |
| GL-R7/R9 | D2/D7：SSH/HTTPS映射、mr-N、缺ref诚实失败，source fallback延后 | 材料已备；相对URL SSH路径与真实部署证据待补 |
| GL-R8/R13 | D3/D7：共享Markdown安全子集+provider输入、有限通知覆盖、登记提示保留旧枚举 | 材料已备；GL4 fixture规格已列，未执行实现测试 |
| 综合验收 | D8/D9：官方默认/自定义实例、精确版本检查点、C1–C7用例与B1–B4缺口 | 材料已备；真实实例/账号仍Not verified，不由本次准备自动触发 |

- [x] GL0 冻结准备：双语候选稿、配置/RPC示例、兼容矩阵、能力范围和测试规格已整理；只完成材料准备。
- [x] GL0 冻结复核：B1–B4证据与范围已逐项确认，ADR-0005 Accepted；本次不授权GL1。

### B1 契约复审：G1–G5 复核通过与收尾（2026-10-27）

用户复审确认 D1–D9 可接收为 B1 基线，并提出 G1 契约空洞及 G2–G5 澄清项。用户随后确认 G1–G5 修订复核全部通过、无新阻塞项。具体字段与语义统一维护在[多实例设计稿](../../architecture/remote-platform-instances.md)，长期取舍记录于 [ADR-0005](../../decisions/ADR-0005-remote-provider-instances.md)（当时Proposed）；本轮记录 B1 复核通过与收尾，不据此勾选整个 GL0 冻结清单。

| 问题 | 处置 | 候选位置 / 复核要点 |
| --- | --- | --- |
| G1 孤儿 grant | 采纳独立纯存储清理路径：新增 v2 remote-retire-grant，允许格式合法的未登记 GitLab scope；写无秘密的 retired signed-out 标记，保留正常 clear-grant 删除/恢复发现语义 | D2 G1、D3/D4、C2：零context/网络；key由Host推导，绑定不符拒绝；刷新CAS失效、跨重启可用、存储故障不冒充成功。已核对锁定seam：modifyRecord返回undefined是不修改，非删除 |
| G2 generation 定位 | 采纳所有 scoped 成功回执顶层 `{remoteProtocol,scope,generation,value}`；capability 内保留的 generation 必须与顶层相同；void为value:null | D3、C1：Client只取顶层；活动操作对应凭据快照，retire专用generation:null不得写确认；跨实例发现、seam off和RPC错误各明示处理，不引入伪造context |
| G3 phase 词汇 | 取消 phase，使用 ScopedRemotePull.rawState + 中立state投影和显式动作守护 | D6、C5：locked保留rawState、禁远端写/closed通知；未知state只读。locked→open的有限替代关系已记录于ADR-0005 Proposed，待整体接受 |
| G4 credentialRef | 明确由Host调用既有resolve(ref)，绑定单实例；首次无值来源跳过，非匿名新token须经该实例GET /user验证；保留名/跨实例ref复用拒绝 | D4、C2/C3：存储异常与非法token/401/已用ref丢失不可伪装首次缺席；网络/限流失败不冒充token失效。signed-out和每操作解析规则保留 |
| G5 能力归属 | operationSupport/方法集/review事件集位于v2 remote-repository facts，与actions同层，可带object/actionScope；capability仅表示实例认证方法事实 | D6、C5：无对象facts不能确认对象写；Host重算守护。明确loginAvailable与App、可写存储、已知/未知flow关系，capability零网络，旧三态不变 |

- [x] B1 G1–G5 修订材料：双语候选、示例与C1–C5补充规格已更新。
- [x] B1 修订复核与收尾：用户确认 G1–G5 通过，补明 retire 先规范化再推导 key，并形成 ADR-0005 Proposed；不自动闭合其他 GL0 前置或晋级 ADR。

该B1检查点的B2 实际 backing store 的838字符key/运行时边界、B3逐端点/部署证据及B4真实实例环境维持原状态；本轮只读核对seam契约，不操作真实记录、ref、账号或实例，不执行GL1代码。

**B1 收尾澄清**：retire 对输入执行规范化后推导 key，https://GIT.EXAMPLE.COM/ 与 https://git.example.com 定位相同规范 scope/key；回执返回规范 scope，Client 也按同一规范化后比较。不将 listRecords 纳入锁定 seam 依赖。用户对上游0.2.1-rc.3语义的复核补充此前本地0.2.0-rc.2证据，均不等于实际store长度实证。ADR-0005为Proposed、ADR-0004不变，B2–B4未验证，GL1未启动。

### B2–B4 证据与最终冻结复核（2026-10-27）

本节为当前证据状态的唯一位置，覆盖前述 B1 收尾时的“未验证”快照。原始结果、npm SRI、provider 入口 SHA-256、服务端文档来源及 SHA-256 见[脱敏证据清单](evidence/remote-platform-gl0-20261027.json)。只保存合成测试结果与公开元数据，不提交 token、ref 值、测试私钥或用户地址。

**B2 · 实际 backing store**：使用正式 npm 包 `@deepseek-ai/dsh-credentials-local@0.2.0-rc.2` 与 `@0.2.1-rc.3`（校验 tarball SRI），分别装配匹配版本的 credentials/Cordis 等依赖；不修改本仓库 manifest、lockfile 或开发 pin。在 Darwin arm64 / Node v24.18.0 的全新临时文件 store 上，两组各 9 项断言通过：512-byte 规范 URL 所产生的 838 字符 key、真实读写、脱敏 describe、0600 文件模式、undefined 不修改、重启持久化、retired 替换清除合成秘密且保留旁项、4 个 OS 进程共 8 次更新无丢失、删除跨重启有效。测试目录完成后删除，未读取用户凭据文件。

可复用探针：[probe-remote-credential-store.mjs](../../../scripts/probe-remote-credential-store.mjs)。复跑须将正式 provider 与其匹配依赖安装到隔离目录，以 `node scripts/probe-remote-credential-store.mjs --provider <provider-lib/index.js> --output <evidence.json>` 调用；探针自行创建/删除 store。**结论：838-key 风险在上述两个实际 provider/运行时组合上闭合**，不等于其他 store、全部 DSH release 或平台已通过。它也不是插件 refresh/retire 状态机验收；store-exclusive 仍须按实际 provider 的正向保证判定。包的 Node 准入范围不变；TLS/代理使用 Host 信任链与启动配置，不增加插件代理字段、全局 dispatcher 或 TLS 绕过。其余 Node/代理/OS 负向属于 C4/C7 实现退出证据，不能由本次 Node24 结果代替。

**B3 · 逐端点契约来源**：逐页获取并散列官方 `gitlab-org/gitlab@v19.5.1-ee` 文档；部署来源为 `omnibus-gitlab@19.5.1+ee.0`。下表均是该精确版本的文献证据，服务端实测另见 B4，不将“文档有端点”等同于目标用户有权限。REST 路径以 `<prefix>/api/v4` 为基址；OAuth 位于 `<prefix>/oauth`。读请求按可见性/read_api 等实际 scope 裁决，写需 api 及对象策略，角色阈值不是充分证据。以下 F/P/U 表示 Free/Premium/Ultimate，字段缺席不按空值或允许处理。

| 用途 / 端点 | 字段、权限/tier 与契约处置 | 精确来源 |
| --- | --- | --- |
| Device `POST /oauth/authorize_device`、`POST /oauth/token` | 每实例 public App + api；device/user code、verification URI、interval、expires_in；pending/slow_down/expired/denied 分别处理；示例未列 refresh_token 不能推出真实不签发 | [OAuth](https://gitlab.com/gitlab-org/gitlab/-/blob/v19.5.1-ee/doc/api/oauth2.md) |
| `GET /user` | 验证当前账号 id/username；不凭 token 前缀或 ref 名推身份；F/P/U | [Users](https://gitlab.com/gitlab-org/gitlab/-/blob/v19.5.1-ee/doc/api/users.md) |
| `GET /metadata`、`/version` | version/revision/enterprise；19.5.1 未记载 plan，EE 不等于付费，缺 plan 不等于 Free；F/P/U | [Metadata](https://gitlab.com/gitlab-org/gitlab/-/blob/v19.5.1-ee/doc/api/metadata.md) |
| `GET /projects/:id` | id/path_with_namespace、clone URLs、merge/squash 设置与可得权限；访问权不直接证明可写；F/P/U | [Projects](https://gitlab.com/gitlab-org/gitlab/-/blob/v19.5.1-ee/doc/api/projects.md) |
| MR 列表/详情、`commits`、`diffs`、`reviewers`（GET） | 按 project + iid 寻址；sha/rawState/draft/detailed_merge_status、diff refs 与双侧路径；有限 diff 不伪装完整；F/P/U | [MR](https://gitlab.com/gitlab-org/gitlab/-/blob/v19.5.1-ee/doc/api/merge_requests.md) |
| Issue 列表/详情（GET） | project + issue_iid、state、作者与正文；保密对象仍依可见性；F/P/U；本轮只读 | [Issues](https://gitlab.com/gitlab-org/gitlab/-/blob/v19.5.1-ee/doc/api/issues.md) |
| MR/Issue `notes`、`discussions`（GET） | notes 的 system/author/time、discussion id/position；old_line 和 new_line 可同时存在；F/P/U；快照不伪造 review 历史 | [Notes](https://gitlab.com/gitlab-org/gitlab/-/blob/v19.5.1-ee/doc/api/notes.md)、[Discussions](https://gitlab.com/gitlab-org/gitlab/-/blob/v19.5.1-ee/doc/api/discussions.md) |
| MR `approvals`、`approval_state`（GET） | approvals 为 F/P/U，CE 仅有限字段且 approved 语义有别于 EE；规则满足情况来自 P/U 的 approval_state，不能以 approved_by 非空代替 | [Approvals](https://gitlab.com/gitlab-org/gitlab/-/blob/v19.5.1-ee/doc/api/merge_request_approvals.md) |
| MR `notes`（POST）、`approve`（POST） | 普通 note 与审批独立回执；approve 带 sha、冲突拒绝；F/P/U 的额外重认证/强制 SAML 限制不得用密码收集绕过 | [Notes](https://gitlab.com/gitlab-org/gitlab/-/blob/v19.5.1-ee/doc/api/notes.md)、[Approvals](https://gitlab.com/gitlab-org/gitlab/-/blob/v19.5.1-ee/doc/api/merge_request_approvals.md) |
| MR create（POST）、update（PUT，state_event=close） | create 核对 source/target project 与已推分支；close/comment/create 无原子 SHA 前置，不宣称 CAS；F/P/U | [MR](https://gitlab.com/gitlab-org/gitlab/-/blob/v19.5.1-ee/doc/api/merge_requests.md) |
| MR `merge`（PUT） | 必带 sha；409 为 HEAD 不符，405/422 分类处理；方法受项目 merge_method/squash 设置及受保护目标分支约束；F/P/U | [MR](https://gitlab.com/gitlab-org/gitlab/-/blob/v19.5.1-ee/doc/api/merge_requests.md)、[Protected branches](https://gitlab.com/gitlab-org/gitlab/-/blob/v19.5.1-ee/doc/api/protected_branches.md) |
| `GET /projects/:id/repository/branches/:branch` | 分支存在/commit.id 与允许 remote 绑定；不自动 push/fork；F/P/U | [Branches](https://gitlab.com/gitlab-org/gitlab/-/blob/v19.5.1-ee/doc/api/branches.md) |
| `GET /todos`、MR `resource_state_events`（GET） | todos 只作候选，state event 有独立 id/state/time；不承诺完整通知或审批历史；F/P/U | [Todos](https://gitlab.com/gitlab-org/gitlab/-/blob/v19.5.1-ee/doc/api/todos.md)、[State events](https://gitlab.com/gitlab-org/gitlab/-/blob/v19.5.1-ee/doc/api/resource_state_events.md) |
| REST 分页与认证 | namespaced path 编码、Link/page/per_page、token 类型与 scope；续页仍逐跳校验实例/前缀/项目/查询；无条件 ETag 不保证存在 | [REST](https://gitlab.com/gitlab-org/gitlab/-/blob/v19.5.1-ee/doc/api/rest/_index.md)、[Authentication](https://gitlab.com/gitlab-org/gitlab/-/blob/v19.5.1-ee/doc/api/rest/authentication.md) |
| 相对 URL / MR head ref | 相对 URL 在该 Linux package 文档仍为 Beta；HTTPS prefix 与 SSH clone path 依服务端 URL 分开验证。关闭/合并后 head ref 有清理规则，但 fetch 失败不能推因 | [Deployment](https://gitlab.com/gitlab-org/omnibus-gitlab/-/blob/19.5.1%2Bee.0/doc/settings/configuration.md)、[MR checkout](https://gitlab.com/gitlab-org/gitlab/-/blob/v19.5.1-ee/doc/user/project/merge_requests/merge_request_troubleshooting.md) |

request-changes 写、unapprove、auto-merge/train、独立 rebase、inline/resolve、Issue 写继续延后；不因某文档列出端点便新增本轮支持。未知版本/付费策略不靠 enterprise 或空 plan 推断，动作 facts 按 D6 收窄。GitLab.com 的账号/策略与其实际 schema 仍须在 GL5 单独验收。

**B4 · 真实隔离环境基线**：用户答复无现有测试实例后，为本次证据任务启动本机 Docker Desktop，并创建全新临时实例；不访问用户 GitLab/凭据。实际为无导入许可证的 EE `19.5.1-ee`（revision `48423440144`），ARM64 镜像 digest `sha256:a1a04d4f28e219d88428d9d514e9305a05c63945c7fb09f11b4e0305e455dfae`。Docker Server 29.3.1、VM 4,108,828,672 bytes/8 CPU；仅回环暴露 HTTPS 18443/SSH 18222。采用 puma workers=0、sidekiq concurrency=5、关闭 monitoring 的低内存配置，因此属于自定义车道，不充当官方默认部署资源验收。

- 无前缀最终探针 **18 项通过**：metadata/user、public App（api scope）的 Device 初始化与无 bearer 的 token pending、项目身份/clone URLs、MR 列表/详情/commits/diffs/discussions/approvals、Issue、todos、第二账号评论与 SHA 审批、错误 SHA merge=409、匿名私有项目=404。
- 改为 `/gitlab` 并 reconfigure、等待就绪后，**14 项通过**：上述身份/读取/URL及 OAuth 路径保持正确。实际 SSH `git ls-remote --refs` 读取目标项目 `refs/merge-requests/:iid/head`，与 API head SHA 相同；HTTPS clone URL 含 `/gitlab`，SSH repo path 不含此前缀，18222 端口有效。host key 从隔离容器固定后严格验证，未修改用户 SSH/global Git 配置。
- TLS 使用带正确 SAN 的临时测试证书，探针逐请求显式信任该证书并验证 hostname；未禁验证、未装全局 CA、未改变 Host/用户信任库。此结果不证明生产 Host 已信任用户实例证书。App、API fixture 凭据、SSH key 与私有项目均为隔离实例内合成数据，未写插件配置或用户 ref。
- 如实保留异常：启动/seed 期间 `oom_kill=1`，两车道结束计数仍为1；第二账号初期曾404，后续成员/身份/读写复测通过，不断言根因；prefix 冷启动曾502，Puma就绪后通过。不据此承诺4 GiB稳定容量或为生产写请求增加自动重试。

复跑工具：[probe-gitlab-gl0.mjs](../../../scripts/probe-gitlab-gl0.mjs)，固定将 `gitlab-b4.test` 路由至回环，只允许空前缀或 `/gitlab`。准备新的隔离19.5.1 EE容器、同名SAN证书、`config/b4-secrets.json`（public App clientId 与仅供 fixture 的管理员 fixtureToken，文件0600），然后 `node scripts/probe-gitlab-gl0.mjs <absolute-isolated-fixture-dir/> [ /gitlab ]`；首次空前缀运行会创建私有测试项目/分支/MR/Issue/第二账号与成员、fixture token。public App 必须按19.5.1要求归属组织；不打印或通过argv传token。前缀测试需先更改 external_url 并 reconfigure/确认就绪。探针会生成含合成秘密的 fixture.json（0600），只能在一次性环境使用；完成后删除整套容器/数据/密钥。本次结果与命令规格已脱敏持久化；完整生产认证/插件实现回归仍需 GL5 独立执行。

**清理结果**：一次性容器、下载的GitLab镜像、bind数据、测试证书/SSH key和合成凭据均已删除，原有postgres镜像保留；脱敏证据与探针保存在仓库。

**最终冻结确认：GL0 设计基线通过，GL1 未启动。** B1 复审已由用户通过；B2 实际 store 长度风险在明确组合内闭合；B3 精确版本契约/部署证据已补齐；B4 按真实隔离环境的准入基线闭合。按本次“补证及最终冻结确认”指示，将 ADR-0005 置为 Accepted、D1–D9 标为 Target（已冻结、未实现），勾选设计清单；ADR-0004 保持 Proposed，仅增加指向有限后续决策的导航。此前各轮 Proposed/未验证记录保留为历史检查点。

冻结不把后续验收提前勾选：真实浏览器批准后的 OAuth token/refresh 双路径、默认部署/CE/付费tier、GitLab.com、fork/双实例、实际完整 merge/close、Node22/代理/TLS负向、Windows/Linux/Web/Desktop 与全部 C1–C7/DSH release 矩阵仍须在 GL1–GL5 完成。GL-R8 仅纳入 D7 有限通知/可信来源/共享安全Markdown子集及后续fixture；GL-R13纳入保留旧枚举的登记修复。17/18、source-ref fallback、request-changes 写等既定延后不扩大。**本次只授权补证与冻结，未获得开始GL1的指示；产品运行时、依赖和Current RPC保持原状，未落地功能继续 fail-closed。**

### 2026-10-27 · GL1 启动授权（历史检查点）

用户在 GL0 冻结后明确授权开始 GL1：实施 provider 接口与逐实例注册表、配置与身份、v1/v2 协议、认证/HTTP、孤儿 grant retire、capability 与生命周期，并以 mock、临时 store/仓库验证。GL2–GL5 业务功能仍未授权；不访问真实凭据、账号或项目，不执行远端写入、提交、push 或发布。上面的“未授权/未启动”保留为 GL0 历史记录，不代表本次状态。真实浏览器 OAuth/refresh 和平台/服务端矩阵仍为 Not verified。

- [x] 接口、实例配置/规范身份及隔离生命周期；配置变更和卸载使用取消/drain，旧响应与旧 OAuth 提交受配置栅栏保护。
- [x] v1 兼容和显式 v2 协商、作用域及 generation；GitHub v2 通过独立适配器保留已实现的操作。
- [x] 逐实例认证、OAuth/刷新、HTTP 边界与纯存储 retire；模拟真实 provider 写后事件。
- [x] capability、fail-closed、定向回归及双语 Current 文档。
- [x] 阶段门禁与适用兼容检查；结果和剩余风险见本节与进度日志。

基线：`pnpm test` exit 0，47 文件 / 528 测试；依赖 source map 缺失和 jsdom canvas 提示未导致失败。日志位置见本轮交接。

**GL1 阶段结论：达到上表退出条件（mock、临时仓库与默认开发 pin 的证据范围）。** 这不是 GL2–GL5 或真实平台验收；GL1 的结构、协议、认证和安全清理入口可供评审。

**D1–D5 / C1–C5 阶段复核**：D1 的 runtime 通过作用域接口与工厂/注册表装配，实例变化和凭据事件隔离；D2 的原始 URL 校验、规范身份、base32、配置/SSH 歧义和原子 retire 有针对性用例；D3 的 Host 宣告、旧通道、作用域信封、控制错误和过期应答有 Host/Client 用例；D4 的实例/App/ref 绑定、来源失效、`GET /user`、可选 metadata 和刷新持久意图/CAS 以 mock store/transport 验证；D5 的 OAuth/REST 分离、prefix、重定向和续页边界有负向 fixture。C1–C3 的 GL1 断言、C4 的认证 HTTP 边界、C5 的 GitHub 仓库事实/写前重核及 GitLab 未实现动作 fail-closed 已覆盖。GitLab 实际项目坐标/分页、locked 投影和对象级写守护属于 GL2–GL4，C4/C5 相关断言不提前声称完成。

**限制与后续**：本阶段未访问真实凭据、账号或项目，浏览器批准后的真实 OAuth 签发/刷新、代理/TLS 负向、GitLab.com/自建服务端及平台/完整 DSH release 矩阵仍为 **Not verified**，由 GL5 另行授权和记录。当前 Client 只新增孤儿清理入口，GitLab 实例选择与认证界面留待 GL4；认证基础可经 scoped RPC 验证。当前 GitLab HTTP 基础对百分号编码的 API 路径保守拒绝；GL2 须在项目/查询绑定验证和相应测试完成后扩展，不能直接放行外部 Link。GL2 从 `src/remote/registry.ts` 的 GitLab scoped provider、`src/remote/gitlab-auth.ts` 与 `src/remote/http.ts` 接口继续，实现真实读取和分页后才开放对应业务端点。


### GL0–GL5 阶段与任务清单（Current / Planned）

GL1–GL4 已完成自动阶段门；GL5 的有限通知已接入，完整矩阵与真实验收仍在进行。未落地的 GitLab 操作继续 fail-closed（拒绝 `git/remote-unavailable`），不影响已可用的 GitHub 入口。

**GL2 自动阶段验证完成（历史检查点）**：已接入受本地 remote、项目 API 身份和认证 generation 守护的仓库事实、MR/Issue、commits、讨论、审批事实与比较；项目路径专用编码、绑定查询和比较快照的游标及相关负向测试已加入。`pnpm test` 59 文件 700 项、`compat:check`、`docs:check`、`build`、`test:artifact` 5 项及 `git diff --check` 均通过；GitLab 服务端 diff 上限独立于分页，完整性显式标为 unknown。GL3–GL5 尚未完成，真实平台验证仍属 GL5。详细可调用范围以 [RPC reference](../../reference/remote-platform-rpc.md) 为准。

**GL3 自动阶段验证完成（历史检查点）**：MR checkout 和 Issue 分支接入受身份、generation、项目与本地 remote 守护的 Host 路径；共享 Git 执行器复用 SHA、CAS 和部分回执。临时仓库覆盖 origin/upstream、fork、脏工作区、head 竞态、tracking CAS/后台前进/分叉、分支冲突、单分支映射、worktree 和配置失败；`pnpm test` 60 文件 721 项、compat/docs/build、5 项 artifact 与 `git diff --check` 均通过。GitLab Client 与远端写仍属 GL4，真实环境验证属 GL5。

**GL4 自动阶段验证完成（历史检查点）**：Host 已接入 MR 评论、COMMENT/APPROVE、创建、关闭和按项目策略直接合并；可移植 Client 提供实例/仓库选择、认证修复、浏览、受支持动作、两步确认及部分/未知结果对账。模拟服务、临时仓库、控制器、组件、Markdown 与隔离浏览器覆盖身份/SHA 变化、锁定对象、能力集合和分步审批。`pnpm test` 66 文件 767 项、`compat:check`、`docs:check`、`build`、`test:artifact` 5 项、`test:e2e` 10 项及 `git diff --check` 均 exit 0。真实 GitLab.com/自建平台与完整 DSH 版本矩阵仍属 GL5，GitHub S7 遗留验收单独跟踪。

**GL5 进行中（Current）**：已实现限于项目绑定 `review_requested` todo、已加载本人 MR 状态快照和已核验 origin/upstream 的 push 建议；changes-requested 通知不可用。作用域/账号去重、取消及可卸载原生增强已补自动测试；完整 DSH 版本矩阵及隔离浏览器回归已通过。真实 GitLab.com/Self-Managed、真实 OAuth/refresh、远端写与跨平台手工验收仍未完成，不以 mock 替代。

**2026-10-28 离线本地验证（历史检查点）**：默认开发 pin 的 `compat:check`、`test`（69 文件 797 项）、`docs:check`、`build`、`test:artifact`（6 项）、隔离 `test:e2e`（11 项）和 `git diff --check` 均 exit 0。合并仅提供项目策略与对象当前有效 squash 事实一致的方法，回执不一致或缺失时保留已合并事实并要求核对。18 个精确 DSH release 已逐车道尝试；离线矩阵总 exit 1，当时结果如下，真实平台仍 **Not verified**：

| 车道结果 | 精确版本 | 证据与限制 |
| --- | --- | --- |
| 自动门禁通过 | `0.1.5-rc.2`、`0.2.0-rc.2`、`0.2.1-rc.3` | 各车道 compat/test/docs/build/artifact/pack 均 exit 0，另各有 11 项隔离浏览器测试通过；`0.1.5-rc.2` 的 797 项中 1 项上游 credentials 契约因该车道缺 seam 按设计跳过，缺 seam 行为另有回归 |
| 安装受阻，后续门禁未执行 | `0.1.5-rc.3`、`0.1.6-alpha.1`、`0.1.6-alpha.2`、`0.1.7-alpha.1`、`0.1.7-alpha.2`、`0.1.7-rc.1`、`0.1.7-rc.2`、`0.2.0-rc.1`、`0.2.1-alpha.1`、`0.2.1-alpha.2`、`0.2.1-alpha.3`、`0.2.1-alpha.4`、`0.2.1-alpha.5`、`0.2.1-rc.1`、`0.2.1-rc.2` | bootstrap/upgrade/公开元数据解析通过，离线 install 均因 `ERR_PNPM_NO_OFFLINE_TARBALL` exit 1；联网安装未获授权，不能据此声明兼容 |

**2026-10-28 授权联网复跑（历史检查点）**：用户随后授权公共依赖联网安装。在仓库外隔离副本及独立 store 中，按[唯一精确清单](../../../src/compat/dsh-version.ts)完成 18／18 车道；bootstrap、适用的 upgrade/install、compat/test/docs/build/artifact/pack 全部 exit 0，矩阵总 exit 0。每个车道另通过 11 项隔离浏览器测试，共 198 项。前 9 个缺 credentials seam 的车道各有 796 项通过、1 项上游 credentials 契约按设计跳过；后 9 个车道各有 797 项通过，所有车道的 6 项 artifact 均通过。开发 pin 与锁文件未变。此证据不替代真实服务端、账号或平台验收。

2026-10-28 准备复核：GitLab 官方[补丁公告](https://docs.gitlab.com/releases/patches/patch-release-gitlab-19-5-1-released/)记录 2026-10-21 发布 19.5.1（CE/EE）。这只是公开发布检查点，并非实际部署或兼容承诺；真实验收当天仍须重新核对稳定 patch，记录所用镜像 digest、App、tier、TLS、Host Node 与命令。

**D9 C1–C7 阶段证据与缺口（本轮真实验收前快照）**（最新 GitLab.com 结果与剩余范围以本计划下方真实验收节为准，自动证据不替代真实验收）：

| 用例组 | 已执行证据 | 仍未验证 |
| --- | --- | --- |
| C1 协议/旧类型 | [scoped Host](../../../tests/remote-scoped-runtime.spec.ts)、[Client](../../../tests/remote-scoped-client.spec.ts)、[产物](../../../tests/client-bundle.spec.ts) 与上述 18 个通过车道覆盖协商、回显、旧通道、缺 seam 和导出加载 | 真实宿主与实际凭据 seam 的平台组合 |
| C2 实例/记录 | [实例与注册表](../../../tests/remote-instances.spec.ts)、[grant](../../../tests/remote-gitlab-grant.spec.ts) 和 retire fixture 覆盖隔离、拒绝与清理；GL0 实际 store 限定证据保留原记录 | 实际部署的其他 store/实例组合 |
| C3 认证 | [认证](../../../tests/remote-gitlab-auth.spec.ts) 和隔离浏览器使用模拟凭据、刷新意图/CAS、取消与令牌不外泄 | GitLab.com/自建实际 OAuth 签发和 refresh、实际账号及跨平台认证 |
| C4 HTTP/分页 | [HTTP](../../../tests/remote-gitlab-http.spec.ts)、[读取](../../../tests/remote-gitlab-project.spec.ts) 与游标负向测试覆盖前缀、编码、redirect/Link、查询/快照、限流与缓存 | 实际代理、TLS/证书故障与真实服务端差异 |
| C5 写/权限 | [写守护](../../../tests/remote-gitlab-write.spec.ts)、[Host 身份](../../../tests/remote-gitlab-write-runtime.spec.ts) 和 Client 测试覆盖项目/账号、策略、SHA、重复提交、分步审批及未知结果 | GitLab.com 与自建实例的真实创建、评论、审批、关闭和合并 |
| C6 Git/Client | [临时仓库](../../../tests/remote-gitlab-checkout.spec.ts)、[控制器](../../../tests/remote-gitlab-controller.client.spec.ts)、[组件](../../../tests/remote-gitlab-panel.client.spec.tsx)、Markdown、通知和全部 18 车道的[隔离浏览器](../../../tests/e2e/gitlab.e2e.ts)覆盖本地操作及 UI | Windows/Linux 和真实 DSH Web/Desktop |
| C7 服务端/平台 | GL0 有单独标识的隔离服务端准备证据；本次 Host/Client 使用模拟服务 | GitLab.com 与官方常规部署、CE/无许可证 EE、内网/端口/prefix、双实例、权限/tier、代理/TLS 和各平台实测 |

### 2026-10-28 · GL2–GL5 独立验收（未通过）

本节保留修复前验收快照；A1/A2 的当前处理结果见下方“修复与本地复验”，不能用历史失败表覆盖修复后的证据，也不能据此跳过 GL5 剩余验收。

**Current 结论：未通过完整验收，不得将 GL5 标记为 Completed。** 本轮检查当前未提交工作树，覆盖 GL2 读取/分页/缓存、GL3 本地 Git、GL4 受守护写与 Client、GL5 通知/兼容和真实环境退出条件，并补充既有测试未覆盖的生命周期交错。既有阶段通过记录保留为历史证据；脱敏结果、源码指纹与逐车道摘要见[本轮验收证据](evidence/remote-platform-acceptance-20261028.json)。本轮仅更新验收记录，不修复产品代码、不提交或发布。

默认开发 pin `0.2.0-rc.2` 的 `compat:check`、`test`（69 文件 / 797 项）、`docs:check`、`build`、`test:artifact`（6 项）和 `pack` 均通过。隔离 `test:e2e` 在沙箱内因 Chromium 启动被系统拒绝而失败；允许浏览器启动后，11 项全部通过。完整 18 个精确 DSH release 及逐车道浏览器回归的本轮结果以证据清单为准；开发 pin 与主工作树锁文件保持不变。自动门禁全绿不能覆盖下述新增失败探针。

**本轮门禁停止记录**：用户指出既有门禁已完成，要求跳过重复执行并总结。本轮停止时已有 16 个版本的适用门禁与各 11 项浏览器回归通过；其余车道未在本轮完成，不改写上文既有 18 车道的历史通过记录，也不宣称本轮完整复跑通过。

| 编号 | 优先级 / 结果 | 可复现问题与影响 | 位置 / 关闭条件 |
| --- | --- | --- | --- |
| A1 | **P1 / Failed** | GitLab 业务请求进入 provider 后，在首次异步会话检查期间移除实例；随后 assertRepository 调用 registry.list()，其串行锁内的 synchronize 等待旧 provider.dispose()，dispose 又等待当前请求。循环等待导致当前请求、后续跨实例发现和 runtime 卸载均挂起，不依赖外部 HTTP 或真实凭据 | `src/remote/registry.ts` 的 synchronize/drain 与 `src/remote/runtime.ts` 的 assertRepository。不得持注册表锁等待依赖该锁的请求结束；增加真实 provider 的移除/改配/卸载交错回归，证明旧请求取消、后续请求与卸载均有界完成，且旧身份不能继续写 |
| A2 | **P2 / Failed** | A 实例 Device Flow 等待中切换到 B；select 取消旧轮询但不清除 login，旧轮询的 catch 因 epoch 变化跳过清理。B 面板保留 A 的设备码和授权链接，B 登录按钮持续禁用；取消时把 A 的 attemptId 发给 B，得到 unknown-attempt | `src/client/remote.ts` 统一控制器的 load/login/cancelLogin（原 `gitlab-remote.ts` 的 select/login/cancelLogin 已并入）；UI 在登录等待时允许切换仓库。切换时清除并按原 scope 终止旧登录，或明确禁止等待期间切换；增加双实例回归，核对链接、取消 scope 与 B 的重新登录 |

可重跑的 [A1 生命周期探针](evidence/remote-platform-lifecycle-20261028.mjs)与 [A2 登录切换探针](evidence/remote-platform-login-switch-20261028.mjs)在 macOS arm64 / Node `v24.18.0` 执行。它们直接调用当前源码，使用合成实例与模拟服务，无外部网络、用户 store 或远端写入；预期不变量均失败（exit 1）。A1 的有界观察窗口结合上述等待依赖确认死锁，不是请求超时设计。既有注册表测试的空 dispose 和登录 HTTP 取消用例不能替代业务请求重入注册表的交错。运行方式为 `node --experimental-transform-types <探针相对路径>`。

| 阶段 | 本轮判断 |
| --- | --- |
| GL2 | 读取、身份/分页/缓存负向与默认 pin 回归通过；A1 影响业务端点生命周期，集成层不能无条件签收；真实服务端差异未验证 |
| GL3 | 临时仓库 checkout、tracking CAS、worktree、Issue 分支和部分回执通过；仍受 A1 影响，实际服务端 HTTPS/SSH 认证与平台组合未验证 |
| GL4 | 已有写前身份/SHA/能力、两步确认、分步审批和未知结果自动用例通过；A1/A2 阻止完整签收，真实平台远端写未验证 |
| GL5 | 有限通知和自动回归已执行；A1/A2 未关闭，真实 GitLab.com/Self-Managed OAuth/refresh、读写、服务端/实例矩阵及 Windows/Linux/真实 DSH Web/Desktop 未完成，故未通过 |

**复验门**：先关闭 A1/A2 并补齐针对性交错回归，再对最终源码运行适用门禁及完整精确版本矩阵。真实验收继续遵循下节的独立资源与授权前置；GL0 服务端探针、浏览器 fixture、构建成功或旧矩阵不能替代插件实现的真实 OAuth/refresh、远端写与平台验收。GitHub S7 遗留验收单独跟踪；本计划不归档，ADR 状态不变。

### 2026-10-28 · A1/A2 修复与本地复验

**Current：A1/P1 与 A2/P2 已修复并通过本地回归，GL5 完整验收仍未完成。** 用户授权定位、制定计划并开始修复；本轮按“复现 → 生命周期修复 → 定向回归 → 默认 pin 门禁”实施，保留现有未提交工作树、开发 pin、锁文件及历史验收证据。

| 项目 | 修复与验证 |
| --- | --- |
| A1 / P1 | 注册表锁内发布快照、移除旧 owner 并触发取消；按实例跟踪 drain。同实例 replacement 在锁外等待 drain，再复核配置；卸载等待当前和已移除 owner，drain 不占准入链。仓库守护在异步会话检查及 list 后检查取消。真实 provider 的移除/改配/卸载交错、旧确认写零 POST、后续发现及卸载均有界结束；注册表测试另覆盖排空期间 list/guard 可用和卸载等待已移除 owner |
| A2 / P2 | 目标切换与身份作废立即清空 login；清理使用原 scope 与独立通道，不复用已取消信号；轮询绑定发起时的 scope/signal，旧 epoch 回复不能更新新目标。双实例回归验证 A 的链接移除、取消发送给 A、B 可重新登录及 A 迟到成功/失败隔离；同实例双项目回归验证旧取消未完成时新登录仍可完成 |

新增 10 项回归，位于 `tests/remote-registry.spec.ts`、`tests/remote-scoped-runtime.spec.ts`、`tests/remote-gitlab-write-runtime.spec.ts` 和 `tests/remote-gitlab-controller.client.spec.ts`。生命周期约束同步至[多实例架构](../../architecture/remote-platform-instances.md)。原 A1/A2 探针不修改，修复后均 exit 0：A1 为 operation rejected、discovery/legacyCapability/disposal resolved；A2 切到 B 后无旧 login，取消仅发送到 A。脱敏结果与最终源码指纹见[修复复验证据](evidence/remote-platform-fixes-20261028.json)。

默认 pin `0.2.0-rc.2`：`pnpm test --maxWorkers=4`（69 文件 / 807 项）、`compat:check`、`docs:check`、`build`、`test:artifact`（6 项）、`pack` 与 `git diff --check` 通过。隔离浏览器 E2E 首轮因 macOS 沙箱拒绝 Chromium 启动失败；允许启动后 11 项通过，fixture 仍阻断非回环网络。未使用真实账号/凭据或远端写入，未提交或发布。

**后续复验计划**：先由外部验收复跑原探针与新增交错用例，再对本次最终源码复跑完整 18 个精确 release 矩阵；本轮仅完成默认 pin，不借用历史矩阵签收。真实 GitLab.com/Self-Managed OAuth/refresh、读写、服务端/实例矩阵及 Windows/Linux/真实 DSH Web/Desktop 按下一节资源与授权前置继续，均保持 Not verified；不得因此勾选 GL5 总完成或归档计划。

### 2026-10-28 · GitLab.com 真实验收（A3/P1，历史 Failed 快照）

**验收快照：GL5 未通过。** 用户要求自动验收，并分别批准创建测试 OAuth App、设备码与 `api` 授权，以及测试项目内的评论、关闭、合并和负向检查。本轮验证源码提交 `3d42a9e48468af84f0f818d5ae488b5cdd54319b`，未改产品代码、开发 pin 或锁文件，未提交/推送/发布。唯一脱敏证据为[GitLab.com 验收记录](evidence/remote-platform-gitlab-com-20261028.json)，包含源码指纹、34 个 RPC 结果、真实分页头、逐车道结果、refresh 与清理事实。

环境为 macOS arm64 / Node `v24.18.0` / pnpm `11.7.0`，使用真实 `GitRemoteRuntime`、`GitLabAuth` 与正式发布的 `@deepseek-ai/dsh-credentials-local@0.2.0-rc.2`，在独立适配器、空 Git 凭据环境和全新 store 中请求真实 GitLab.com；不是完整 DSH Web/Desktop 启动验收。metadata 实测 `19.6.0-pre` 只记录当时 GitLab.com 返回值，不作为 Self-Managed 版本承诺。浏览器独立核对网页状态；正常 Host TLS 信任，无证书绕过。App 必须同时配置 public、`api` scope 和 **Device authorization grant**，只有 client_id 与 scope 不足以启用设备流程。

| 范围 | 本轮结果 |
| --- | --- |
| A1/A2 与兼容门禁 | 原探针均 exit 0，4 个相关测试文件 / 53 项通过。修复后最终源码的 18／18 精确 DSH release 重新安装并通过适用的 bootstrap/upgrade/install、compat/test/docs/build/artifact/pack；缺 seam 的前 9 车道各 806 项通过 / 1 项按设计跳过，后 9 车道各 807 项通过。默认 pin 的隔离浏览器首次被沙箱阻止启动，获准后 11 项通过；本轮没有逐车道重跑浏览器，不把历史 198 项计入本轮 |
| OAuth / store / refresh | 真实 Device Flow、`GET /user` 身份和独立 store 持久化成功；实际 provider 的 9 项隔离 store 探针通过，含四进程八次更新。确认实际 store 互斥证据后，仅在独立认证引擎的一次到期比较中注入时钟，真实请求 `/oauth/token` 完成 access/refresh token 与 revision 轮换，后续时间计算恢复真实时钟，新进程重读 grant 验证身份成功。未等待自然到期，不宣称覆盖自然到期或真实跨进程刷新崩溃场景；产品设置未改变 |
| 真实读取与本地 Git | 仓库身份、MR/Issue 详情、当前审批事实、空 todo 结果和 Issue 本地分支成功。独立 Git 凭据为空时 checkout 返回 `outcome:unknown` / `git-transport-or-local-failure`，没有谎报切换成功；成功的 Git 传输/checkout/push 仍未验证 |
| 真实远端写 | 在本轮新建私有项目 `cherrchen/gl5-acceptance-20261028` 创建 3 个 MR；!1 关闭，!2 直接合并且实际源分支仍存在，!3 一条合成评论。相同 requestId 返回相同 comment id，网页/API 确认仅一条；同 id 改内容返回 submission-conflict。自审批被拒绝，错误 SHA 返回 git/head-moved，!3 仍开放。无第二账号，成功审批及请求评审通知投递仍未验证 |
| **A3 / P1 / Failed** | MR/Issue 列表、notes/discussions、commits 和 files 在真实 GitLab.com 返回 invalid-response。服务端给 first/last Link 补入 `id`、`order_by`、`sort`、`with_labels_details` 等路由/默认参数；`gitlab-project.ts` 的 next 对所有 rel 调用 `http.ts` 的严格非 page 查询相等校验，即使 x-next-page 为空且仅一页也报错。HTTP 200 和真实头已保存；现有 mock 的简化 Link 没覆盖该响应形状 |
| 清理 | 当前测试 access token 已在 GitLab 撤销（200，之后 `/user` 401）；本地 signed-out marker 与凭据文件均不再含 access/refresh token。验收项目、MR/分支和 OAuth App 保留供审阅，未授权永久删除。隔离矩阵副本、缓存与打包产物在保留脱敏日志后清理，不操作用户缓存 |

A3 可用[离线分页头重放探针](evidence/remote-platform-gitlab-com-links-20261028.mjs)复现：`node --experimental-transform-types docs/plans/active/evidence/remote-platform-gitlab-com-links-20261028.mjs`。无网络、无凭据，原验收基线 **exit 1**，是应通过却失败的验收不变量；修复后的重跑结果见下节，原失败证据保留。关闭条件：支持真实服务端的合法分页元数据，保留实例/项目/路径/查询/游标边界和恶意 Link 负向；补回归并重新执行真实列表/集合/比较及相关门禁。本轮只验收与记录，不修复 A3。

Self-Managed、fork/双实例/端口/prefix、权限/tier/代理/TLS 负向、第二账号正向审批/通知、Windows/Linux 和完整 DSH Web/Desktop 仍为 Not verified。空 todos 不能证明通知已投递；本轮可移植适配器不能证明完整宿主集成。GitHub S7 仍单独跟踪，计划不归档。

### 2026-10-28 · A3 修复与真实复验

**Current：A3/P1 已修复，真实读取复验通过；GL5 完整验收仍未完成。** 用户授权修复、再验收后提交。本次在 `http.ts` 按具体端点核对服务端的路由回显和已验证默认值，再以原 Host 查询和已验证页码生成续页。原请求的显式非默认值保持权威；未知/重复附加参数、错误项目/对象、过滤变化、跨实例/前缀/路径和跳页继续拒绝。适用契约见[RPC reference](../../reference/remote-platform-rpc.md)，不通过放宽全部查询或跳过 first/last 校验规避问题。

[修复复验证据](evidence/remote-platform-a3-fix-20261028.json)保留基线与最终源码指纹、原探针、测试摘要、真实 RPC 和分页路径。修复前，新增用例及调整后的游标用例有 8 项失败；修复后定向 56 项通过，新增 21 项覆盖六组真实分页头及恶意参数，原探针的 12 个 Link 全部通过。默认 pin 的 69 文件 / 828 项测试和 11 项独立浏览器 E2E 均通过；原 A1/A2 探针也单独复验。最终源码 18／18 精确 release 的重新安装及适用的 bootstrap/upgrade/install、compat/test/docs/build/artifact/pack 均 exit 0；前 9 个缺 seam 车道各 827 项通过 / 1 项按设计跳过，后 9 个车道各 828 项通过，逐车道 artifact 各 6 项通过。本轮浏览器仅在默认 pin 跑 11 项，不借用历史逐车道浏览器结果。

复用既有测试账号、同一 App 和原 `api` scope，在全新 store/临时仓库中以真实 `GitRemoteRuntime` 请求 GitLab.com，未新增项目或远端业务写入。MR 列表返回 3 条、Issue 列表 1 条，MR notes、discussions、commits、diffs 各 1 条，Issue notes/discussions 返回空页，全部成功；文件比较仍保留 `serverCompleteness:unknown`。另以真实 `GitRemoteHttp` 和修复函数，在现有 MR 列表设置每页 1 条，验证 3 页 Link 与请求路径，获得 !3/!2/!1，无重复或遗漏；这不是对 50 条以上真实 Host 游标的承诺，Host 不透明游标通过带规范化 Link 的两页回归覆盖。

本轮测试授权在真实读取完成后撤销，独立 store、临时本地仓库和矩阵安装/缓存/产物在导出脱敏证据后清理；既有测试项目及 App 保留。仅本地提交修复、双语契约/计划和验收证据，不推送或发布。此前 Self-Managed、Windows/Linux/完整 DSH Web/Desktop、第二账号正向审批/通知、成功 Git 认证传输等未验证范围保持原状态，不将 A3 关闭等同 GL5 完成。

### 2026-10-28 · Draft PR 与跨平台 CI

**Current：用户要求以 Draft PR 提交评审，自动跨平台验收交由 CI。** [主 CI](../../../.github/workflows/ci.yml) 已配置 Linux/Windows/macOS 三系统开发 pin 车道，涵盖完整单测、生命周期/分页探针、浏览器 E2E、文档、构建与产物；其余精确 release 维持 Ubuntu 兼容矩阵。覆盖、报告保留和边界唯一说明见[浏览器与 CI 验证](../../development/browser-e2e.md#ci-跨平台验收)。当前 PR head 的 CI 成功前保持 Pending；真实账号/自建服务端、完整 DSH Web/Desktop 宿主和原生增强卸载不由这些 fixture 自动签收。GL5 不因此标 Completed，PR 保持 Draft，发布和合并另行处理。

首轮 [CI 40661503394](https://github.com/cherrchen/dsh-plugin-git/actions/runs/40661503394) 的 Linux/macOS 通过，Windows 单测 16 项失败，后续步骤未执行。修复 Windows 8.3 路径身份误判，并修正测试 Git 查找、文件名与路径断言；补充别名/异检出边界及显示路径回归。修复后的当前 head 仍须重新通过三系统主 CI 与兼容矩阵，不借用首轮结果签收。

### 剩余验收的执行准备（Not verified）

- **DSH 联网矩阵**：如获准联网安装公共 registry 的精确版本及其传递依赖，在仓库外新建输出目录，用 `node scripts/run-dsh-matrix.mjs --online-install <新建的绝对输出目录>` 逐车道运行兼容检查、测试、文档、构建、artifact 和打包。工具在隔离源码副本、pnpm store 和空 npm 用户/全局配置中运行既有 upgrade workflow；安装过程允许相关包安装脚本，主工作树的开发 pin 和锁文件不改。保留脱敏逐车道日志与 `results.json`；验收后只清理该次新建的副本、包缓存与产物，不清理其他工作树或用户缓存。
- **真实环境前置**：先由用户明确指定可丢弃的 GitLab.com 测试项目与 fork、专用账号/OAuth App，以及独立的 Self-Managed 测试实例和项目，并授权列明的真实 OAuth 与远端写入。自建首要车道为官方常规部署、CE 或无许可证 EE、无 prefix、SSH 22 和有效 TLS；补充内网、独立域名、非默认端口、prefix、双实例相同数字 id 及权限/tier/代理/TLS 负向车道。执行当天复核官方稳定 patch，记录确切版本、镜像 digest、App 配置、tier、TLS、Host Node、平台与命令；不把历史 17/18 自动列为支持版本。
- **隔离操作**：使用专用临时本地仓库和独立凭据 store，经既有凭据 seam 安全导入测试身份，绝不把 token 放进对话、RPC、日志、argv 或 Git 传输。分别验证 GitLab.com 与自建 OAuth 浏览器签发/refresh、fork 和作用域隔离、读取/分页/权限负向、checkout 与 Git 传输认证；仅在明确批准的测试资源中 push 测试分支，并执行 MR 创建、评论、审批、关闭和直接合并，以及 SHA 竞态和未知结果对账。分别记录 Windows/Linux 与真实 DSH Web/Desktop 结果和 Desktop 增强卸载行为；不可用的车道保持 Not verified。
- **清理与边界**：先导出脱敏结果，再只撤销本轮创建的测试 App/grant 和凭据、移除隔离 store/本地临时仓库，并在事先明确批准的测试资源范围内清理本轮创建的项目、MR、分支及容器数据。保留可长期引用的脱敏证据；任何真实凭据、项目或远端写入授权缺席时不执行相应步骤。GitHub S7 剩余手工验收单独跟踪。


| 阶段 | 前置依赖 | 退出条件 |
| --- | --- | --- |
| GL0 · 技术评审 | 当前 GitHub 实现与 ADR-0004 | 确认候选主结构及 GitLab.com/自建实例范围；GL-R0–R12 的全部 P1 闭合，GL-R8 与 GL-R13 明确纳入/延后，并完成下方冻结清单；结论、设计依据与真实验收前置可追踪 |
| GL1 · provider/认证边界 | GL0 + 明确实施授权 | runtime 依赖接口及工厂/注册表装配、provider/实例注册配置与 URL/host-id 规范、独立 grant/App、HTTP/SSH 映射与 capability；GitHub 旧设置兼容，无跨账号泄漏 |
| GL2 · GitLab REST 读取 | GL1 | GitLab.com 与自建实例的 namespace/project id/iid、MR/Issue/commits/discussions/审批读取、分页与缓存隔离测试通过；只开放已完成读取 |
| GL3 · Git 集成 | GL2 的仓库与 SHA 快照 | checkout/Issue 分支临时仓库测试通过，tracking CAS 与部分完成可核查 |
| GL4 · 受保护写与 Client | GL1–GL3 | 逐操作能力、身份/SHA 守护、MR UI/两步确认/未知结果对账；不支持动作可见禁用 |
| GL5 · 集成验收 | GL1–GL4 | 已纳入通知能力、GitHub 回归、完整 DSH release 矩阵与 GitLab 服务端版本/实例矩阵、授权后的真实平台/手工验收和同步文档全部完成 |

- [x] GL0 准备：现状差距、拟议范围、官方资料、GL-R0–R9 和分阶段验收门已写入双语计划；这只代表材料就绪。
- [x] GL0 评审记录：接收用户提供的 Conditional GO，记录 GL-R0–R9 处置、新增 GL-R10–R13 与复核修正；只代表评审已记录，不代表 P1 闭合或设计冻结。
- [x] GL0 冻结：D1–D9设计基线和ADR-0005已冻结，P1设计项闭合、P2纳入/延后明确；仅在另获开始实施的指示后进入GL1。
- [x] GL1：按上表实现 provider/认证边界并完成本阶段检查；真实验收缺口仍见本节。
- [x] GL2：按上表接入并验证 GitLab REST 读取；服务端真实验收仍属 GL5。
- [x] GL3：完成 GitLab 本地 checkout/Issue 分支与临时仓库阶段检查。
- [x] GL4：实现受保护远端写和可移植 Client，并同步 canonical 文档和双语文案；真实平台验收保留 GL5。
- [x] GL5：完成完整精确 release 矩阵与适用门禁；默认开发 pin 的定向测试及最终 `compat:check` / `test` / `docs:check` / `build` / `test:artifact` / `test:e2e` 结果单独记录，不能替代其他车道。
- [ ] GL5：另行记录获授权隔离环境中的 GitLab.com 与自建 GitLab 真实认证/读写与 Windows/Linux/Web/Desktop 验收；未执行保持 **Not verified**，mock 不能替代。GitHub S7 的未完成验收继续单独跟踪。

**评审提交物**：以本节作为下一轮入口，附 GL-R0–R13 逐项结论、provider/实例/动作能力矩阵、GitLab 服务端支持版本与实例配置矩阵、RPC/设置兼容方案、mock/临时仓库用例与真实验收清单。GL0 冻结本身不构成实现或真实验收证据；最新实现范围和验证状态以上方 Current 记录为准。计划只在 S7 与已确认纳入的 GL 阶段均完成验证后归档；若以后拆分或延后 GitLab，先明确记录范围调整与承接计划。

## 2026-10-29 平台认证便捷登录（In progress）

### 目标与已核实现状

用户已在规划后授权实施：把孤儿 GitLab grant 清理收进默认折叠的“高级”；把 OAuth 整理成“点击连接 → 自动获取用户码 → 打开系统浏览器 → 用户确认 → 自动显示已登录”。下列代码与隔离验证已落地（Current）；真实应用注册及平台验收仍待完成，不改变 GL5 的验收状态。

当前代码已通过 `remote-login` 自动申请设备码、通过 `remote-poll-login` 轮询并经 `ctx.credentials` 保存 grant；用户不需要自行申请设备码。当前入口缺失的常见原因是应用 `client_id` 未配置：GitHub 位于 `Config.remote.clientId`，GitLab 位于对应实例的 `clientId`。公开应用 ID 是维护者一次性注册所得，不是每次登录的 `user_code` 或 Host 保留的 `device_code`。

实施前缺口：Client 仅显示用户码与手动外链，没有主动打开浏览器或复制操作；`RemoteLoginAttempt` 没有保存有效期；GitLab Host 已校验 `verification_uri_complete`，但未将其返回 Client，Client 当前也只接纳无 query 的验证 URL；GitHub/GitLab 的等待状态和错误反馈仍需统一。代码落点以 [RPC 参考](../../reference/remote-platform-rpc.md)及 `src/remote/{auth,gitlab-auth}.ts`、`src/client/remote.ts`、`src/client/remote/RemoteAuth{Control,Section}.tsx` 为准。

### 官方依据与范围

核查日期：2026-10-29。

- [GitHub OAuth Device Flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)：应用需先启用 Device Flow；设备端请求与轮询使用 `client_id`，不需要 `client_secret` 或回调服务器。文档只保证普通 `verification_uri` 和 `user_code`，本轮不依赖自拼查询参数来预填 GitHub 设备码。
- [GitLab Device Authorization Grant](https://docs.gitlab.com/api/oauth2/#device-authorization-grant-flow)：17.2 引入、17.3 默认启用、17.9 GA；响应可含 `verification_uri_complete`，用来减少手工输入。支持情况仍按实例事实判定，不仅凭版本号放行。
- [GitLab 应用注册](https://docs.gitlab.com/integration/oauth_provider/)与 [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628.html)：仍需要注册应用及其 ID；本轮按 public client、不内置 client secret 的 Device Flow 实施。自建 GitLab 使用在该实例注册的应用，不复用 GitLab.com 的 ID。

沿用现有 GitHub OAuth App + `repo` 和 GitLab public OAuth Application + `api` 方案；不把 GitHub App 的细粒度权限迁移混入本轮，其授权范围、安装和 API 权限需另行评估。PKCE/回调协议、GHES 和 Git 传输认证也不在本轮范围。

### 交互与实现顺序

| 阶段 | 实施内容 | 退出条件 |
| --- | --- | --- |
| O1 高级区域 | `RemoteAuthControl` 使用原生 `details/summary` 或已有同等折叠原语，默认收起；“清除已移除 GitLab 实例的授权”及 URL、检查、确认、结果全部置于其中。平台通知范围说明保留在认证弹窗，正常连接方式仍直接可见 | 中英文、键盘展开、默认收起、规范 URL 二次确认和清理错误行为均验证；清理不因折叠而自动执行或取消 |
| O2 应用配置与发行 | 明确应用所有者、名称与公开 ID。开发/自建部署保留显式配置；正式发行以发布配置提供 GitHub.com/GitLab.com 的维护者应用 ID，用户通常无需注册。配置优先级为显式实例/平台配置高于发布默认；缺任一有效 ID 时仅该平台显示配置提示，禁止借用 gh/glab/第三方应用 ID | 维护者应用注册并启用必要能力；应用 ID 来源、覆盖/禁用语义与 App 变更后的 grant 失效规则登记完毕。未取得真实 ID 前，代码使用隔离 fixture，不能宣称开箱即用 |
| O3 登录契约补齐 | 登录结果增加可选 `verificationUriComplete`，统一携带/保留 `expiresAt`、`intervalMs`；旧 Host 无新字段时回退普通验证页。GitLab 由 Host 对完整 URL 校验后返回，Client 再校验实例 origin、部署前缀、精确 `/oauth/device` 路径、唯一且匹配当前 `userCode` 的 query；GitHub 保留精确 `/login/device` 约束 | v1/v2 兼容、缺可选字段、自建部署前缀、恶意 query/外域/旧 attempt 拒绝均有测试；不暴露 `device_code`、token 或 client secret |
| O4 浏览器与用户码 | OAuth 由用户选择后申请一次设备码；成功后每个 attempt 仅自动打开浏览器一次。GitLab 优先用验证过的 complete URL；GitHub 打开官方普通验证页并显示“复制设备码”，用户粘贴并确认。两平台都保留复制、重新打开和取消操作，明确显示已复制或打开失败 | 浏览器打开成功不被当成授权成功；打开/复制失败可手工继续，复制不成功时不提示成功；重渲染、弹窗重开、切换 tab 不重复弹浏览器 |
| O5 状态与生命周期 | 两平台统一申请中/等待授权/验证账号/已连接/拒绝/过期/取消/网络失败的文案；倒计时按服务端有效期计算。复用现有轮询及 CAS，不另建第二条轮询；完成后刷新正确实例的 capability/viewer/list，CLI/OAuth 均保留 | `interval`、`slow_down`、过期、拒绝、取消和重复点击通过；工作区/实例/App/账号变化使旧 attempt 无效，取消后迟到响应不能更新账号；关弹窗不等于取消，重开可恢复进行中的 attempt |
| O6 验收与发布 | 单测、隔离浏览器、可选 Desktop 卸载、真实应用登录和双语文档检查；完成后更新 Current RPC/架构说明 | 满足下方验收门再记录完成；注册应用、真实账号授权与发布属于独立外部操作，按用户授权执行 |

Desktop 宿主现有源码可见 `shell.openExternal(url): Promise<void>` 和 `clipboard.writeText(text): Promise<void>`。实施时在既有子 `ctx.inject(['desktop'], ...)` fiber 中接入结构回调，能力检测后提供给 Remote feature，卸载时撤回；不引入 Electron import、preload global 或 Desktop provider 包依赖。HTTP/轮询继续位于标准 Host，浏览器打开位于用户当前 Client 所在设备，以适配远程 Host。无 Desktop 时主 UI 保留验证链接与设备码；Web Clipboard 仅在可用且用户显式点击时使用，浏览器限制导致无法自动打开时提示点击链接。

授权链接自动打开仅跟随本次用户主动发起且仍有效的 attempt；不在 capability 探测、刷新、过期或应用启动时自动创建新授权。Token 沿用 `ctx.credentials` 与现有刷新互斥门，实际是否由系统钥匙串保护取决于所选存储 provider，不能从接口名称推断。

### 验收门与待确认前置

- [x] O1：高级默认折叠；展开后仍可完整执行规范化 URL → 检查 → 确认 → 结果；无 v2 seam 时不展示不可用清理。
- [x] O2 公开 ID：维护者于 2026-10-29 提供 GitHub/GitLab.com 应用 ID，唯一登记于 [`oauth-apps.json`](../../../oauth-apps.json)，普通 Host 构建自动嵌入；真实应用能力及自建实例的注册、权限与 Device Flow 可用性仍属 O6 验收。应用注册表单可能要求填写 Redirect URI，不代表本流程需要运行回调服务器。
- [x] O3：Host 与 Client 双重 URL 校验、可选字段向后兼容、倒计时及 query 与当前用户码绑定；RPC、日志与 argv 不泄露秘密。
- [x] O4/O5（隔离）：GitHub CLI → OAuth → CLI E2E，GitLab glab 来源的组件选项及旧 Host 清 grant → retry 兼容回归；两平台的成功、拒绝、过期、取消及打开浏览器失败均有隔离 E2E。Mock Desktop 验证 URL/打开次数和卸载后的手工继续，CI 不连接真实 OAuth。
- [x] O6 自动化：`pnpm test --maxWorkers=4`（73 文件 912 项）、`pnpm test:e2e`（25 项）、构建、artifact（公开 ID 接入后 7 项）、兼容性、文档与空白检查。另用临时产物构建验证公开 ID 嵌入、环境覆盖/显式禁用及构建标记替换；Client 产物不含发行应用 ID。
- [ ] O6 真实平台：真实 GitHub/GitLab 应用登录与 glab 身份、macOS/Windows 浏览器及凭据存储体验。真实公开应用 ID 已配置；未操作真实账号授权或凭据，未实测部分保持未验证。

实施优先 O1，再完成不依赖真实应用 ID 的 O3–O5；O2 的维护者注册可同期准备，缺 ID 不阻塞隔离实现，但阻塞“普通用户开箱即用”的真实验收。当前已实现高级折叠、登录契约/URL 校验、控制器拥有的浏览器打开/复制/生命周期、本地化结果和构建期发行 ID（`DSH_GIT_GITHUB_CLIENT_ID`、`DSH_GIT_GITLAB_CLIENT_ID`）；显式空配置禁用发行默认，自建实例不继承公共平台应用。初期按用户要求先完成代码与隔离测试；维护者现已提供公开 ID 并纳入普通构建，真实应用 Device Flow、账号 OAuth、系统原生体验和发布仍未验证。O4/O5 路径已有 mock 自动化覆盖，真实 glab 身份与平台验收另行保留。

### 2026-10-29 认证缓存修复（Current）

CLI/OAuth 的选择现在与 OAuth grant 分开持久化；切到 CLI 保留授权，切回 OAuth 先复用缓存，新增仅 OAuth 退出并保留 CLI 登录。协议和存储边界以 [RPC 参考](../../reference/remote-platform-rpc.md#配置与认证) 为准。隔离测试覆盖两平台引擎重建、缓存复用、过期与畸形偏好拒绝、GitLab 校验期间其他 owner 切换方式、设备登录不因自身偏好更新而被取消；浏览器重建 Host 后再次切换，以及 CLI 活跃时仅退出 OAuth。真实平台/系统存储验收仍未执行。

认证恢复补充：修复持久 signed-out 被当成持续错误并清空 GitLab 认证入口的问题；保留退出状态和仓库事实撤回，通过实例 capability 恢复显式认证。控制器覆盖 CLI/OAuth 恢复及 capability 暂时失败后的重试，浏览器使用 GitLab.com 的模拟 glab/设备流程分别验证。

限流隔离补充：GitLab 实例读取器原先共用的限流截止时间、失败次数与服务端轮询间隔现按凭据摘要保存，覆盖读取和写入；切回旧凭据仍保留原期限。单元及隔离浏览器回归覆盖 CLI 限流 → 已保存 OAuth 恢复 → CLI 仍受限，不需要重新授权或重复发送受限请求。

## 验证

### 分层证据

| 范围 | 方法与记录要求 |
| --- | --- |
| S0 / GL0 初期评审准备文档任务（不含另行授权的补证） | **只运行** `pnpm docs:check` 与 `git diff --check`，日志保存在仓库外绝对临时路径并在交接中给出；不运行 build/unit/artifact，不联网安装 |
| S1–S6 / GL1–GL4 | 每阶段使用相应窄范围 Host/Client 测试、mock transport/store/clock 和临时仓库；记录具体命令、退出码、覆盖的验收门与未覆盖项 |
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
| 自建 GitLab 实例与 host-id | 已纳入 GL0–GL5；GL-R9 必须闭合 URL/凭据隔离、服务端版本、App、TLS 与可访问测试实例等前置，不影响既有 GitHub 首期验收；GHES 仍延后 |

GitLab 本轮工作位于当前 `feat/remote-gitlab` 分支；若之后获准提交，使用用户正常 Git identity，绝不加 Generator 或 Co-author 归属；未请求不 push/publish。

### 进度与验证日志

| 日期 | 阶段 | 记录 |
| --- | --- | --- |
| 2026-10-22 | S0 | 已阅读仓库规则、文档 skill/template、branch/mirror note、ADR 最终 15 条及计划索引；需求与设计按已定结论整理，双语计划/索引已写。`pnpm docs:check` 通过（55 个 Markdown、569 个链接、188 个文件名，exit 0）；`git diff --check` 通过（无输出，exit 0）。日志位于仓库外临时文件，绝对路径随交接报告提供 |
| 2026-10-22 | S1 | 落地 `src/remote/{types,credentials,feature}.ts`、`src/types.ts` 重导出、`src/index.ts` remote 边界分发与错误适配；`tests/remote-feature.spec.ts`、`tests/remote-endpoints.spec.ts` 新增。`pnpm exec vitest run tests/remote-feature.spec.ts tests/remote-endpoints.spec.ts tests/rpc-channel.spec.ts tests/host-entry.spec.ts`：4 文件 63 例全过；`pnpm build:types:standalone` exit 0；`pnpm docs:check` 与 `git diff --check` 通过；日志存仓库外临时目录（路径见交接报告） |
| 2026-10-22 | S2 | 落地 `src/remote/{settings,errors,grant,http,probe,auth}.ts`、`Config.remote` schema 与 `@deepseek-ai/dsh-credentials` optional peer（`CREDENTIALS_SEAM_DSH_RELEASES` 子集）；`tests/remote-{auth,http,probe}.spec.ts` 新增。`pnpm exec vitest run tests/remote-auth.spec.ts tests/remote-http.spec.ts tests/remote-probe.spec.ts tests/remote-feature.spec.ts tests/remote-endpoints.spec.ts tests/rpc-channel.spec.ts tests/host-entry.spec.ts`：7 文件 98 例全过；`pnpm build:types:standalone`、`pnpm compat:check`、`pnpm docs:check` 与 `git diff --check` 均 exit 0。该次阶段检查时认证引擎仍未接 RPC，capability 为 `off`；后续进展见下方续作日志。无真实 OAuth。日志存仓库外 `/tmp/dsh-git-s2/` |
| 2026-10-22 | S2–S7 续作 | 认证取消/slow_down/URL/正文超时修复；落地 `provider/github-model/github/git/runtime/diff`、RPC 接线与 Client 远程 surface/controller/通知。定向测试与类型检查已通过，主车道 43 文件 442 例通过；`compat:check`、`docs:check`、`build`、`test:artifact`（4 例）均 exit 0；17 个精确版本最终门禁全过，逐车道见下方。真实 OAuth、远端写入及跨平台手工验收 **Not verified** |
| 2026-10-22 | S3/S6 续作 | 远程列表/评论/文件读取从"预算内一次取尽 + truncated 警示"改为游标渐进流式补页：`RemotePage` 增 opaque `next`，`remote-list-*`/`remote-comments`/`remote-files` 接受 `cursor`/`pages`，Provider 校验游标 origin 且单请求页数有界；Client controller 改追加式状态、后台串行续取、按 number/id/path 去重、限流按 resetAt 有界恢复一次；`remote-files` 续页以 expected SHA 钉住比较快照；truncated 警示条移除，files 未取尽前行内评论保持禁用。通知线程展开与写路径坐标校验的有界收集不变。`pnpm test` 43 文件 448 例、`pnpm build`、`pnpm docs:check` 均 exit 0。真实远端验收仍为 **Not verified** |
| 2026-10-22 | S3/S6 续作 | PR 详情页不再主动渲染文件改动：新增 `remote-commits`/`remote-reviews` 读端点（`RemoteCommit`/`RemoteReview` 模型，`state` 归一五种），文件改动改为 `pr.url + '/files'` 的 GitHub Files 页外链按钮；commit/review 历史沿用游标流式加载，行内评论按 `reviewId` 嵌套进对应 review 只读展示；composer 移除行内提交入口（无锚点选择器），`remote-files`/`remote-inline-comment` 保留为受守护能力但 Client 不再调用。附带修复详情页 load/open 失败后的无限重试循环（按 key 记已尝试项）。`pnpm test` 43 文件 451 例、`pnpm build`、`pnpm docs:check` 均 exit 0。真实远端验收仍为 **Not verified** |
| 2026-10-24 | S3/S6 续作 | 详情页重做时间线与正文渲染：`RemoteIssue`/`RemoteComment` 增 `createdAt`、`RemoteCommit` 增 `committedAt`（取自 `commit.committer.date`）；新增纯模块 `github-markdown.ts` 把 GitHub 允许的 HTML 子集（details/summary、注释、img/a/br/code/pre/table/列表/alert 等）投影为可读 Markdown，`RemoteMarkdown` 以原生 `<details>` 渲染折叠块；新增 `timeline.ts` + `RemoteTimeline` 取代 `RemotePullHistory` 与评论分区，按时间交错排列评论、提交、review 与行内 thread（空的 per-reply review 隐藏、孤儿 thread 独立成项）；详情页正文作为开场卡与后续项同槽对齐，详情页改用 20px 横向内边距。认证弹窗改为状态卡 + “连接方式”方法行：`authAction` 接受端点序列在同一 busy 周期内按序执行、首个失败即停；Local/Git credential 重连在 signed-out/invalid/source=grant 时自动前置 `remote-clear-grant`，sign-out 与清除本地授权的区别改由“断开连接”与按方式重连表达，独立的重试/清授权按钮移除。首轮 `pnpm test` 47 文件 510 例、`pnpm test:e2e` 7 例通过。第二轮（同日期）按截图反馈修订：timeline 头像改为真实 GitHub 头像——`github-model.ts` 新增 `avatarUrl()` 仅放行 `https://avatars.githubusercontent.com`（无凭据），viewer 与各 `author.avatarUrl` 经它投影；新增 `RemoteAvatar`（`s=size*2`、`loading=lazy`、`no-referrer`，onError/缺失回退首字母圆点），头像与 marker 均不透明以遮住时间线。认证弹窗加宽至 440px，并简化为状态卡（头像/StateDot + 标题 + 来源副行 + 右侧断开连接）加 GitHub CLI / GitHub OAuth 单选组，选中态仅由 capability 派生；方法说明、断开提示与传输提示文案移除（`remote-use-git-credential` 端点与 Git credential 来源展示保留）。验证结果同上，均为 exit 0。真实远端验收仍为 **Not verified** |
| 2026-10-27 | GL0 评审准备（仅文档） | 核对当前 GitHub 耦合和 GitLab 官方资料，新增拟议范围、GL-R1–R8 与 GL0–GL5 任务/验收门，同步英文及两级导航。`pnpm docs:check`、`git diff --check` 均通过；首次 pnpm 调用自动执行安装元数据对齐和 `prepare` 构建（exit 0），未主动运行实现测试、未改代码/依赖、未使用真实凭据。GL0 评审未通过、GL1–GL5 未开始；本轮授权仍限文档准备 |
| 2026-10-27 | GL0 候选主结构补充（仅文档） | 按用户指示将统一接口、平台适配器、实例配置和独立认证上下文列为候选主结构；明确工厂/注册表装配、继承与组合的待评审取舍，新增 GL-R0 并关联 GL0/GL1 退出条件，同步英文。自建实例仅进入扩展结构模型，交付范围不自动扩大；评审未通过，未开始实现。文档检查结果见本轮交接 |
| 2026-10-27 | GL0 自建 GitLab 范围调整（仅文档） | 按用户指示将 Self-Managed 纳入本轮 GL0–GL5 候选交付，补齐实例 URL/端口/部署前缀、host-id/凭据隔离、逐实例 App/ref、TLS/SSH 映射与服务端版本/实例验收矩阵；新增 GL-R9，更新阶段门和双语导航，保留既有范围调整历史。评审仍未通过，未修改实现或访问真实实例；文档校验结果见本轮交接 |
| 2026-10-27 | GL0 技术评审接收与复核（仅文档） | 接收用户报告的 Conditional GO，采纳 interface + 组合为修订主方案；逐项记录 GL-R0–R9 处置，追加 GL-R10–R13、契约兼容/host-id/坐标/权限/元数据/通知/代理修正与 GL1 前冻结清单。同步英文与索引；旧 Current RPC、代码、依赖和 ADR 状态未改，GL1–GL5 未开始。未操作真实账号或实例；文档检查结果见本轮交接 |
| 2026-10-27 | GL0 处置记录复审修订（仅文档） | 接收用户对处置记录的复审通过结论；核对实际工作分支，双语修正 F1。采纳可选 F2，在 GL-R8、冻结清单及 GL4 证据要求中显式补入 Markdown 变体/共享子集决策。剩余 P1 未闭合，GL0 未冻结，GL1 未启动；文档检查结果见本轮交接 |
| 2026-10-27 | GL0 冻结准备（仅文档） | 新增双语 Target 多实例/协议设计稿，整理 D1–D9 候选、C1–C7 用例与 B1–B4 缺口；保留v1导出/wire语义，要求显式协议宣告与scope回显。按用户补充采用官方常规部署/最新稳定大版本主场景，附官方版本来源，不预承诺较老大版本。补齐导航与准备追踪表。P1仍未冻结，未操作实现/依赖或真实实例；文档校验结果见本轮交接 |
| 2026-10-27 | B1 G1–G5 契约修订（仅文档） | 接收用户对D1–D9基线的评审；补齐孤儿grant纯存储清理、统一顶层generation、取消phase、逐实例ref解析/失败边界及仓库/对象support归属与实例认证方法事实。同步双语、示例和用例规格；从锁定本地类型/README核对modifyRecord不修改语义。该检查点B1仍待复审，B2–B4维持未验证；未操作运行时/凭据/实例，文档校验见本轮交接 |
| 2026-10-27 | B1复核通过与ADR收尾（仅文档工具） | 接收用户G1–G5复核通过结论；明确retire输入规范化/规范scope回显与不依赖枚举，新增双语ADR-0005 Proposed，不改变ADR-0004状态。最小修正文档检查器：英文ADR视图与canonical共用编号且必须有配对；隔离正/负回归证据见本轮交接。B2–B4维持未验证，运行时/依赖未改，GL1未启动 |


| 2026-10-27 | GL1 实施与阶段验证 | 用户授权后落地实例注册表与 provider 接口、v1/v2 协议和 GitHub 适配、逐实例 GitLab 认证/HTTP/刷新、retire 与 Client 双重确认，GitLab 业务端点继续 fail-closed。基线 `pnpm test` 为 47 文件 528 例；最终 `pnpm compat:check`、`pnpm test`（56 文件 638 例）、`pnpm docs:check`、`pnpm build`、`pnpm test:artifact`（5 例）及 `git diff --check` 均 exit 0。隔离 `pnpm test:e2e` 首次因 macOS 沙箱拒绝 Chromium 启动 exit 1，沙箱外重跑 8 例全过；fixture 阻断非回环网络。source map 与 jsdom canvas 提示为基线已有、未影响测试。日志位置见交接。未使用真实账号/凭据或远端写入，真实验收与完整 release 矩阵仍 Not verified |
| 2026-10-27 | GL2 实施与自动阶段验证 | 接入项目绑定的 GitLab 读取、透明 scope 信封、受限编码、Host 游标与缓存、讨论/审批投影及 SHA 绑定比较；写入和 Git 集成仍关闭。定向测试覆盖 prefix、子组、fork、跨实例 id、恶意路径/Link、游标替换、取消、限流、缓存串账号及快照变动；`pnpm test` 59 文件 700 项、compat/docs/build、5 项 artifact 和 `git diff --check` 均 exit 0。GitLab diff 的服务端完整性显式 unknown。日志见交接；真实平台与完整 release 矩阵仍 Not verified |
| 2026-10-27 | GL3 实施与自动阶段验证 | 使用共享 argv Git 执行器接入目标 MR head ref checkout 与 Issue 分支，绑定实例/项目/账号/generation 和 requestId；私有 ref、tracking CAS、后台推进、worktree 与分步回执有临时仓库证据。`pnpm test` 60 文件 721 项、compat/docs/build、5 项 artifact 和 `git diff --check` 均 exit 0。未访问真实凭据或远端，GL4/GL5 和 GitHub S7 遗留验收仍未完成 |
| 2026-10-28 | GL4 与 GL5 本地回归 | 完成受守护写、可移植 UI 与有限通知；补强作用域回显缺失、发送后身份变化和实际 squash 回执的未知/部分结果处理。默认 pin 主门禁通过，完整 18 车道离线尝试中 3 车道通过、15 车道缺本地包而未完成；每个可运行车道另有 11 项隔离浏览器测试通过。未使用真实账号/凭据或远端写入；GL5 与 GitHub S7 的真实验收仍未完成 |
| 2026-10-28 | 授权联网 DSH 矩阵复跑 | 在仓库外独立 store 和源码副本中完成全部 18 个精确版本的适用门禁，各车道 6 项 artifact 和 11 项隔离浏览器测试通过；缺 seam 的 9 条旧车道各跳过 1 项上游契约。主工作树开发 pin 与锁文件保持原状。真实平台及 GitHub S7 遗留验收仍未完成 |

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

| 2026-10-27 | GL0 B2–B4补证与最终冻结 | 两个正式file-backed provider各9项通过；21份精确版本官方文档/hash与逐端点表；隔离EE19.5.1两车道18/14项及真实SSH MR head SHA通过。异常/资源限制/未验证范围和清理记录见B2–B4及脱敏JSON；ADR-0005 Accepted、设计Target，GL1未授权/未启动。未改产品运行时/依赖；检查结果见交接 |
| 2026-10-28 | GL5 Client 统一 UI 重构 | 合并 GitHub/GitLab 双控制器为统一 GitRemoteController（v1+scoped 双通道），删除 GitLabRemotePanel 与 provider 手工切换：provider 由 remote-repositories v2 远端 URL 身份自动决定，unregistered/ambiguous 逐条提示，不匹配报 unsupported。GitLab 复用共享列表/详情/tab UI（含新 tab、时间线、评论、审批、合并、检出、通知），地址加 gitlab/<instance>/<path> 五段语法互不碰撞；notes/discussions/commits/approvals 投影为共享视图模型。`pnpm test` 70 文件 857 项、tsc 双配置、compat、docs、git diff --check 均 exit 0。真实平台验收仍 Not verified |
