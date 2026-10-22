# ADR-0004：Git 远程平台集成——credentials seam 门禁、REST 传输与 provider 抽象

- **Status**: Proposed（设计评审项已全部闭合，待冻结）
- **Date**: 2026-10-21

> 正文 `Decision` 为归并后的唯一实施依据，已完整吸收 R/F/G/H 各组评审修订；初始决策原文移入「初始决策（历史）」，全部评审与处理记录按时间保留于「后续修正」。

## Context

本插件需要一个新右侧边栏 tab，提供托管平台远程功能：初期 GitHub，预留 GitLab；范围含 PR 列表/详情、Issue、checkout、review 提交、评论、merge、create PR——即对标准齐 VSCode `vscode-pull-request-github` 与 IDEA 内置 GitHub/GitLab 集成的能力面（编辑器内嵌 Review Mode 经决策**不实现**，本包无编辑器面可挂）。

这正式反转了既有非目标——根 README、[范围与需求总览](../requirements/scope-and-requirements.md)与 `AGENTS.md` 均声明 "GitHub authentication, hosting-provider workflows, credential prompts, issues, pull requests" 在本包之外，"until a separate decision adds them"。本 ADR 即是该 decision。

驱动约束：

- NFR-1/`AGENTS.md`：Host core 只用标准 DSH 服务，绝不 shell/Electron；
- Windows 桌面端**每条子进程弹一个控制台窗口**（已记录的宿主行为，见 [troubleshooting](../troubleshooting/windows-desktop-console-flood.md)），高频子进程调用有 UX 成本；
- OAuth 授权产物需要**持久化与刷新安全**的存储；宿主无 VSCode SecretStorage/IDEA PasswordSafe 的同名物，但上游 `@deepseek-ai/dsh-credentials` 提供 `ctx.credentials` seam——`GrantRecord` 明文就是为 "authorization grant from a sign-in flow" 设计，`modifyRecord` 提供跨进程序列化 RMW（文档明示为 token 刷新安全），`describe*`/`record-updated` 提供不含值的 wire-safe 视图与变更事件；
- `ctx.credentials` 在锁文件中仅见于 `0.2.0-rc.2` 及以后副本——旧宿主可能没有该 seam。

## Decision

以下 15 条为归并后的唯一实施依据，已完整吸收全部评审修订；实施者无需逐轮推导何者生效。

1. **门禁：`ctx.credentials` 缺席即整功能缺席。** 结构性探测全部实际调用方法（`readRecord`、`modifyRecord`、`deleteRecord`、`resolve`、`describe`、`describeRecord` 及 `record-updated` 事件发射面），缺一即 `remote` off 并给出 reason，不做逐方法降级。Host 不装配 remote 运行时，`/git` 通道对 `remote-*` 端点返回 `git/remote-unavailable`；Client 按 `remote-capability` 轮询结果动态注册/注销 `git.remote` tab type（沿用 worktrees 先例）。不做版本字符串判定、不做半功能降级——实际可用宿主 ≥0.2.0-rc.2，旧宿主行为零变化。

2. **凭据持久化 = `ctx.credentials` GrantRecord 状态机。** 记录键 `credentialKey('dsh-plugin-git', <host-id>)`（如 `github-com`；自建实例的无碰撞 host-id 编码为开放项）。payload v1：`{ v, state, revision, accessToken?, refreshToken?, tokenType?, scope?, expiresAt?, userId?, login?, host, attemptId?, refreshId?, at? }`；`state ∈ authorizing | authenticated | refreshing | signed-out | reauth-required`；每次持久提交携带新的不可复用 `revision`。`modifyRecord` 是唯一写路径，一切授权状态迁移都发生在其 mutate 回调内；`at` 仅作展示。不另建文件、不写 settings、不碰 OS keychain。

3. **token 解析与发现链。** 后台顺序：GrantRecord（authenticated）→ `resolve(GH_TOKEN`/`GITHUB_TOKEN)` ref → `gh auth token` → 匿名；ref 分层由 provider 定义、以 `resolve().source` 如实展示，不承诺固定层级。`gh`/helper 子进程只在身份建立事件（seam mount、凭据事件、用户重试、401 失效后重解析）串行触发，每事件至多一轮，不进逐 REST 路径；capability 探测零子进程零网络。`git credential fill` 仅为用户显式动作，非交互契约：`GIT_ASKPASS=''`（空值覆盖非删除）、`GIT_TERMINAL_PROMPT=0`、`SSH_ASKPASS_REQUIRE=never`、`GCM_INTERACTIVE=never`、`-c credential.interactive=never`、≤5s 硬超时、输出上限；凭据探针的 stdout/stderr 不透传 RPC 错误与日志。凭据经 401 验证失效 → `invalid` + 修复提示，不回退换身份；匿名仅在从未存在凭据时被选择。

4. **凭据变化检测与 generation。** Host 维护 credentialContext `(host, source, fingerprint)`：fingerprint 为 token 的进程内不可逆摘要（SHA-256 截断），不跨 RPC、不进日志；解析结果变化即失效 viewer/permissions/ETag 缓存、递增 revision、重新 `GET /user`。`reference-updated`/`record-updated` 事件仅作失效提示，真值以解析比较为准。`generation = { instanceId, revision }`：instanceId 为 Host 启动随机值（重启不复用），revision 单调递增；Client 持有不透明句柄。

5. **登录与登出。** OAuth Device Flow：登录开始即在 mutate 内 CAS 写 `{ state:'authorizing', attemptId }`；完成时仅当 `attemptId` 匹配才写 authenticated grant + 新 revision。`client_id` 经 `Config.remote.clientId` 注入（未配置则隐藏登录入口，发现链照常）；scope `repo`；处理 interval/`slow_down`/code 过期/`access_denied`/取消/重复登录互斥；App expiring-token 与否运行时兼容——无 `refreshToken` 的 token 到期转 `reauth-required`；组织 SSO 拒绝单独呈现。登出 = 同 key 覆写 `{ state:'signed-out', revision:新 }`（持久抑制发现链、重启有效、重新登录覆写清除）。"清除本地授权（恢复自动发现）" = `deleteRecord`，文案注明不在 GitHub 服务端撤销 token。

6. **token 刷新 = 两阶段持久意图协议。** prepare：mutate CAS 把到期 `authenticated` 写为 `{ state:'refreshing', refreshId, basedOnRevision }`，**提交失败不发送**（token 未被消费，下轮重试安全）；execute：marker owner 在锁外发送——互斥锁不覆盖网络调用；complete：mutate CAS 校验 `refreshId + basedOnRevision` 匹配才写新 token 对 + 新 revision，状态已变则丢弃收到的新 token。旁观与恢复：读到 `refreshing` → 按记录时间有界等待（≤TTL），超时 mutate CAS 转 `reauth-required`；非 owner 绝不重发；"marker 已提交未发送即崩溃"同样按已燃烧处理。**保证：可能被服务端消费过的凭据快照绝不再次用于刷新交换**——唯一例外是传输层确认请求未发出；发送后一切非确定结果（超时、响应丢失、任意 5xx/网关错）均视为可能已消费 → `reauth-required`；确定性拒绝（`invalid_grant`/`bad_refresh_token`）→ `reauth-required`；complete 持久化失败 → 新 token 对丢弃、`refreshing` 由旁观规则收敛、如实上报"远端已更新、本地未提交"。跨进程互斥以 backing store 支持为前提，不支持时自动旋转不可用并在 capability/文档中明示，不靠重试代偿。

7. **capability 四层分离**（互不推导）。`credential { configured, writable, source? }` 纯存储事实；`auth { state: off | anonymous | unauthenticated | signed-out | authenticated | invalid, source? }`；`viewer { host, userId, login, name, avatarUrl }`（每 generation 至多一次 `GET /user`）；`permissions` 原样透传 `/repos/{o}/{r}` 权限位；逐动作 `canComment / canReview / canMerge / canClose / canCreatePr` 三态 `true | false | 'unknown'`——`unknown` 时 UI 乐观可用、服务端裁决，`canMerge` 取 push 位，`canClose` = 作者本人或 push 位。seam 缺席时 capability 仍返回结构化 `{ state:'off', reason }`，其余 remote 操作明确拒绝。

8. **传输与 origin 边界。** Host 内 `fetch` 直连 REST（`api.github.com`，`X-GitHub-Api-Version` 头，AbortSignal 取消，分页上限）；`gh` 不作传输层。provider 分别声明 `apiOrigin` 与 `webOrigin` allowlist：带 `Authorization` 的请求（含分页 Link 与重定向跟随）仅 `apiOrigin`；`html_url`、openExternal、device-flow `verification_uri` 走 `webOrigin` HTTPS 校验且不携带 token。REST 而非 GraphQL。

9. **写操作一致性。** 全部 `remote-*` 写端点 payload 携带 host/owner/repo/对象号 + `expectedGeneration` + `expectedViewer`（`host + user.id` 稳定 id，login 仅展示）；逐操作 resolve 的单一凭据快照同时完成身份核对与该次调用，核对后 context 已变即拒绝、Client 刷新重确认，不得换另一份 token 发写。远端身份断言：payload 的 host/owner/repo 必须等于本地 origin/upstream 聚合解析出的身份（`assertSessionRepository` 只证本地路径一致）；写端点逐个进 `isRepositoryWrite`；工作区切换取消未发写。merge 必带 `expectedHeadSha` → GitHub `sha` 前置参数，head 已动 → 刷新重新确认；review 必带 `commit_id`（展示时 head SHA）；merge/close 两步确认（沿用 discard 先例）；permissions 预检 + protection/scope 拒绝透传；create PR 的 fork head/base 为显式模型字段。已发送写超时/取消 → "结果待确认" + 定向刷新对账；非幂等写不自动重试。

10. **remote 解析与聚合。** `git remote -v` 识别 provider/host/owner/repo（SSH 与 HTTPS 两种形式）；origin + upstream 聚合同 provider；无 remote 或不支持 provider → 分类状态。

11. **Checkout PR**（无 Review Mode）。按序：① payload remote/head 属于聚合允许集合（远端身份绑定）；② `git fetch <remote> +<provider.headRefspec(n)>:refs/dsh-git-remote/pr/{repoKey}/{n}`（私有 ref 含 base 仓库身份，防 origin/upstream 同号 PR 共享暂存）→ `rev-parse` 核验 == API `head.sha`，不一致即上游 race 刷新重试；③ tracking 预备：`git update-ref refs/remotes/<remote>/<head> <verifiedSha> <expectedOldSha>`（缺失 ref 用全零"不存在"预期值；条件失败有界重读——已相等直接用 / 已领先并入 race 重试 / 分叉失败上报；只表达"已核验快照"，不代表远端最新），`remote.<name>.fetch` 不含 head 时 `git config --add` 补映射（追加保留原映射，供 single-branch clone 后续 fetch 覆盖）；④ `git switch -c <name> <verifiedSha>`，或复用同名同 SHA 分支（先经 ③ 补齐再核其 upstream 指向期望 remote/head，不一致拒绝）；⑤ `git branch --set-upstream-to=<remote>/<head>`。命名：同仓库 PR 用真实分支名 + tracking；fork PR `pr-{n}` 不带 upstream；同名异 SHA 拒绝并给手动命名入口。成功判据 = `rev-parse HEAD` == 目标 SHA。失败回执：①–③ 失败 → **不创建/切换分支、不改 index/工作文件**，报"未切换，准备部分完成" + 已完成阶段清单（`privateRefWritten`/`trackingRefPrepared`/`fetchMappingAdded`）；④ 之后失败 → 实际 HEAD + 未完成步骤标记（如 `upstreamNotConfigured`）；不自动删分支，不承诺跨 ref/config 原子回滚、不盲目清理。端点整体计入 `isRepositoryWrite`（含 config 写入）。Git 传输认证不桥接插件 OAuth token：私库 fetch 依赖用户既有 git 凭据，提示区分"平台认证 OK / git 传输未认证"。脏工作区拒绝并说明。

12. **行内评论坐标。** 使用 `line`/`side`（多行 `start_line`/`start_side`），不以已弃用 `position` 为契约；`commit_id` 与坐标取自同一比较快照。远端 diff 模型保存 path、base/head SHA、old/new 原始行号与 side 锚点，渲染层引用锚点不反推行号；删行/重命名/多 hunk/过期线程/多行范围/patch 截断须可靠定位，否则可浏览但禁用行内提交并说明。

13. **预算与缓存。** 匿名 = 仅手动刷新（不自动轮询）；认证 ≥60s 或遵 `X-Poll-Interval`/`Retry-After`/reset；429 与 secondary-rate-limit 403 指数退避；ETag 条件请求仅适用认证流量；缓存键含 `(host, viewer, repo, 完整查询串)`；分页硬上限；per REST 操作只做进程内 seam resolve。

14. **通知。** review 请求 / 自己 PR 的 merged·closed·changes-requested / push 成功后建议建 PR，按事件 id 去重；经 `ctx.inject(['desktop'])` 子 fiber 的 `notification.show`；web 端降级为 tab 内徽标。

15. **首期范围与开放项。** Issue = 列表+详情+评论只读 + 一键开分支（`issue-{n}-{slug}`，复用 createBranch/switchBranch）；评论 = PR 级 + 行内；review = approve/comment/request-changes 含行内、`commit_id` 绑定；create PR = 已推送远端分支（含 fork head），创建流程内不做 push（引导走现有 push RPC）；PR 文件比较保留。不做：Review Mode、issue 写操作、自定义查询、hover 卡片与补全、TODO→issue、suggestion 本地应用、GitLab 实现、GHES/自建实例（结构预留）。错误码集：`remote-unavailable / unauthenticated / signed-out / insufficient-scope / head-moved / rate-limited(resetAt) / write-result-unknown / remote-identity-mismatch`。

## 初始决策（历史）

> 以下为评审前的原始 Decision 文本，仅作历史保留；实施以正文 `Decision` 为准。

### 原始 Decision

1. **credentials seam 为整功能硬门禁**。`ctx.credentials` 不存在（旧宿主或未挂 provider）时，本次开发的全部功能不提供：Host 不装配 remote 运行时（`/git` 通道对 `remote-*` 端点返回 `git/remote-unavailable`），Client 不注册 `git.remote` tab type（按 `remote-capability` 轮询结果动态注册/注销，沿用 worktrees 先例）。探测是**结构性的**（服务存在且有 `readRecord`/`modifyRecord`），不做版本字符串判定，也不提供砍半降级——实际可用宿主 ≥0.2.0-rc.2，旧宿主行为零变化。

2. **OAuth grant 持久化 = `ctx.credentials` GrantRecord**。记录键 `credentialKey('dsh-plugin-git', <host-id>)`（如 `github-com`，id 空间天然兼容未来 GHES/自建实例）；payload 为本插件自有格式（access token、refresh token、expiry、login、scopes），seam 不解释。刷新经 `modifyRecord` 互斥 RMW；capability 的 `authState`/`authSource`/`writable` 由 `describeRecord`/`describe` 推导；订阅 `credentials/record-updated` 使外部修改即时生效。**不**另建文件、不写 settings、不碰 OS keychain。

3. **传输 = Host 内 `fetch` 直连 GitHub REST API**（`api.github.com`，带 `X-GitHub-Api-Version` 头；AbortSignal 取消；分页 + ETag 条件请求）。`gh` CLI **不**作传输层，仅保留为 token 发现来源之一。

4. **token 解析顺序**（Host 侧，逐操作解析不跨操作缓存）：`ctx.credentials` GrantRecord → `resolve(GH_TOKEN / GITHUB_TOKEN refs)`（seam 分层：store > env > .env）→ `gh auth token` → `git credential fill`（stdin `{data}` 喂 protocol/host，`GIT_TERMINAL_PROMPT=0`）→ 匿名降级（公共仓库只读，me 类分组隐藏）。

5. **登录 = OAuth Device Flow**：`POST /login/device/code` → 展示 user_code + verification_uri → 轮询授权端点 → `modifyRecord` 落 GrantRecord。client_id 为公共值（device flow 设计上无 secret），经 `Config.remote.clientId` 注入而非内嵌；未配置时登录入口隐藏，发现链照常工作。登出 = `deleteRecord`。

6. **Provider 抽象 + GitHub 先行**：`RemoteProvider` 接口封装 host 识别、API 路径、认证头、refspec（GitHub `pull/{n}/head` ↔ GitLab `merge-requests/{n}/head`）、术语与 state 映射（PR↔MR、merged↔`opened`）；共享中立数据模型，UI 标签按 provider 取名。GitLab 本期不实现，仅约束接口不泄漏 GitHub 私名。

7. **REST 而非 GraphQL**：读与写全部走 REST v3——端点直观、分页标准、限流语义可预期（authenticated 5000/h，304 不占主限额）。

8. **Checkout PR 无 Review Mode**：`git fetch <remote> pull/{n}/head:pr-{n}` 后走既有 `switch-branch`（同仓库 PR 直接切 head 分支；GitLab 为 `merge-requests/{n}/head`）；脏工作区拒绝并说明原因（stash 仍为非目标）；不记录进入前分支、无审阅横幅、无返回捷径。

9. **写操作安全模型**：merge/close 两步确认（沿用 discard 先例）；`permissions`（仓库 push/triage 位）预检驱动 UI 启停；protection/scope 拒绝透传 API 错误；破坏性操作不自动重试；写成功后定向刷新。

10. **通知**：review 请求、自己 PR 关键状态变化、push 后建议建 PR——经 `ctx.inject(['desktop'])` 子 fiber 的 `notification.show` 结构方法；web 端降级为 tab 内徽标。

11. **类型依赖纪律**：`@deepseek-ai/dsh-credentials` 加为 optional peer，仅 `import type`；`credentialKey`/`credentialRef` 的品牌语法（`<scope>/<id>` 小写连字符、POSIX 标识符）在本地等价构造，不引入运行时导入——seam 缺席的旧宿主上 bundle 仍能加载。

## Alternatives Considered

- **`gh` CLI 全托管**（传输+认证）：需要用户预装且 `gh auth login` 过；Windows 桌面端每条子进程弹控制台窗口，轮询式调用会放大成窗口风暴；`gh --json` 字段映射仍要自己维护。仅保留其 token 出口作发现链一环。
- **`git credential approve` 写 OS helper 链**：helper 链是 git HTTPS basic 凭据位（username/password），塞 OAuth grant 语义错位；各平台 helper 行为不一、可能弹提示；上游 seam 是产品内一致设施且自带跨进程 RMW 与 wire-safe 视图。helper 链仅保留为**发现**来源（`credential fill` 读已有项），不作写入。
- **settings `role('secret')` 存 PAT**：redact 只保证 wire 不泄密，底层仍是明文文档，且无 grant 生命周期/refresh 语义；OAuth grant 无法用该形态表达。留作未来可选输入，不进本设计。
- **OAuth loopback redirect**（本地 HTTP server 收 code）：体验更接近 VSCode，但引入本地端口生命周期与宿主打包面；device flow 无 server、易 mock、与 headless profile 相容。将来若有需要可另 ADR 增补。
- **GraphQL API**：单请求聚合好，但 schema 复杂、限流计点模型不透明、REST 已覆盖全部 MVP 端点。性能优化留给未来。
- **seam 缺席时降级提供发现链+匿名的只读版**：行为在两个宿主代际间不一致，匿名 60/h 限额体验差，且"半功能"状态机会显著膨胀。门禁统一更简单可预期。
- **GitLab 同期实现**：单一 provider 先验证抽象；差异点已枚举收进接口。

## Consequences

**正面**：复用上游一致凭据设施（与 LLM key 同水位、跨进程刷新安全、wire-safe describe、变更事件）；零新二进制依赖；旧宿主加载路径与行为完全不变；`remote-capability` 轮询/动态 tab 注册、两步确认、`optionalService` 探测均有现成先例；GitLab 接入面收敛到一个 provider 实现。

**负面/成本**：

- 功能实际生效宿主 **≥0.2.0-rc.2**——`engines.dsh` 与 peer OR 不变（插件在旧宿主仍加载，只是 Remote tab 不出现）；该差异必须在 README 与 `docs/reference/dsh-compatibility.md` 写明，`compat:check` 探测面扩到 credentials seam；
- OAuth 硬前置：产品侧须注册 GitHub OAuth App、开启 Device Flow、并经 `remote.clientId` 注入；未配置时仅发现链可用；
- GrantRecord 落在 `.credentials.yaml` 文件（非 keychain）——与 LLM key 同级，但用户文档须如实说明；
- REST 请求数多于 GraphQL：靠 ETag + ≥60s 轮询 + 手动刷新控制；
- 写操作面使 GitHub provider 实现体量显著增大（review/comment/merge/create/checkout 五族端点）。

## Related Documents

- [范围与需求总览](../requirements/scope-and-requirements.md)——非目标反转与 FR-15+/NFR-6+ 修订落点
- [当前架构总览](../architecture/overview.md)——RemoteService/tab 注册模式落点
- [DSH 兼容契约](../reference/dsh-compatibility.md)——credentials seam 探测面
- [Windows 桌面端控制台风暴](../troubleshooting/windows-desktop-console-flood.md)——不选 `gh` 传输层的背景
- [`AGENTS.md`](../../AGENTS.md)——便携性与 provider 分离约束的来源

## 后续修正

### 2026-10-21 技术评审

**结论：方向可行，建议保持 Proposed；以下 P1 项解决前不冻结设计。** Host REST、credentials grant、portable 主 fiber 与 Desktop 子 fiber 的组合符合现有边界。本轮只追加评审，不改写前述决策；以下内容是待处理意见，不代表已实现或已采纳。

证据范围：当前 Host/Client 实现、锁定的 `dsh-credentials@0.2.0-rc.2` 类型与 README、本地可读的 `0.2.1-rc.2` 对应契约，以及本节链接的 Git/GitHub/GitLab 官方文档。没有使用真实账号或对远端执行写操作。文中的 R 编号是评审追踪号。

#### R1 · P1 · 存储元数据不能推出认证状态与远端操作权限（Decision 1、2、9）

`describeRecord` 只返回 `configured`、`kind`、`writable`；`writable` 明确定义为能否写入凭据记录。它不能验证 token 是否撤销、当前用户是谁、是否有 API 写权限。`describe` 也不知道 `gh` / Git helper 的发现结果。按正文直接推导 `authState` 与统一 `writable`，会把“可写凭据文件”与“可 merge PR”混淆。仅用仓库 `push/triage` 位禁用全部写动作也会错禁有权评论、提交 review 或关闭自己 PR 的用户；仓库角色与 token 权限是不同维度，见 [GitHub 角色权限表](https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization)。

建议拆开 `credentialConfigured`、`credentialWritable`、实际 `authSource`、验证后的用户身份和逐动作 capabilities（含 unknown）。认证校验及仓库/对象权限由 Host/provider 获取，服务端 API 仍作最终裁决。门禁应探测实际调用的全部必需方法，或对 `resolve` / `describe*` / `deleteRecord` 等分别降级；只检查 `readRecord/modifyRecord` 不能保证后续调用成立。

验收：凭据存储只读但 token 有仓库写权限；存储可写但 token 只读或已撤销；普通贡献者评论/review、作者关闭自己的 PR；结构不完整的 credentials provider 均有明确结果。

#### R2 · P1 · `deleteRecord` 无法实现预期的登出，且可能被在途登录重新写回（Decision 4、5）

当环境变量或 `gh` 已登录时，删除 GrantRecord 后下一次操作会自动发现同一账号或另一个账号，界面随即重新登录；在途 Device Flow 成功后仍可能再次写入 grant。逐操作重新解析还意味着打开确认框时是账号 A，提交时可能已换成账号 B。正文没有规定缺失凭据、无效凭据与主动登出的区别。

建议明确“删除插件授权”和“停止使用此 host 的所有自动发现来源”的不同语义；若保留“登出”名称，应给出有明确作用域及持久性规则的抑制发现状态与重新登录动作。无效的高优先级凭据应提示修复，不能默默换身份执行写操作。登录/登出、外部凭据更新和 provider 卸载需要 auth generation：停止旧轮询、拒绝过期登录结果写回，清理账号相关缓存；确认后的写请求也要验证身份未变。RMW 只解决存储互斥，不自动表达用户取消意图。

验收：grant + env + `gh` 同时存在时登出；登录尚未完成时登出；弹出 merge 确认后外部换账号；旧请求在切换账号后返回，均不得恢复旧身份或复用旧账号的私有数据。

#### R3 · P1 · `GIT_TERMINAL_PROMPT=0` 不能保证凭据发现不交互（Decision 4、Alternatives）

[Git 凭据文档](https://git-scm.com/docs/gitcredentials#_requesting_credentials)明确列出 askpass 路径。本轮在隔离临时目录中设置一个只返回占位值的 `GIT_ASKPASS`，清空 helper 配置，设置 `GIT_TERMINAL_PROMPT=0` 后调用 `git credential fill`，askpass 仍被执行且命令成功。这足以否定该环境变量可单独保证“只读已有凭据”的假设；helper 本身还可启动自己的交互流程。

建议规定经过验证的非交互调用策略：阻止 Git 的 askpass 路径、对支持的 helper 显式禁用交互（例如 [GCM 的 `credential.interactive=false`](https://github.com/git-ecosystem/git-credential-manager/blob/main/docs/configuration.md)），并设置硬超时、取消和输出上限。任意第三方 helper 未必遵守统一开关；不能保证静默时，应限制自动发现范围或改为用户显式触发。凭据输出不得经过现有通用 `GitCommandError` 的 stderr/detail 透传到 Client 或日志。

验收：无 helper、askpass 已配置、helper 需要重新登录、helper 挂起与取消；后台刷新均不得弹出认证 UI，也不得泄露 stdout 中的 token。

#### R4 · P1 · PR checkout 尚未保证检出正确提交与保护已有本地分支（Decision 8）

当前 [`GitService.switchBranch`](../../src/service.ts) 只执行 `git switch <branch>`。同仓库 PR 直接切 head 分支，可能切到不存在或落后于远端的本地分支。固定目标 `pr-{n}` 又没有仓库身份或所有权：已有同名分支时，fetch 可能移动用户分支；PR force-push、目标分支已在另一 worktree 检出或存在本地提交时还可能失败。脏工作区检查不能覆盖这些情况。[GitHub 的 fetch 示例](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/checking-out-pull-requests-locally)是创建分支的基本操作，并非完整的重复 checkout 策略。

建议定义以 base repository + PR 标识隔离的私有抓取 ref，并明确本地分支冲突、重复 checkout、force-push 与 linked worktree 的策略；不得自动覆盖用户提交或强制更新正在检出的分支。同仓库与 fork PR 都需要抓取并核验目标 head SHA，再进入用户选定的 checkout 状态。另须明确 Git 传输认证：仅在 `ctx.credentials` 保存 OAuth token 并不会让现有 Git 子进程自动具备私库 fetch 权限；若 Git 认证仍由用户独立配置，应在 capability/失败提示中如实表达，若要桥接则需另行定义便携且不落盘、不进入 argv/日志的方案。

验收：全新 clone、落后/分叉的 head 分支、用户已有 `pr-1`、PR force-push、同一仓库多个 worktree，以及仅插件 OAuth 已登录但 Git 尚未认证的私库。

#### R5 · P1 · 两步确认缺少远端对象和提交的一致性约束（Decision 9）

若用户确认期间作者又推送提交，直接 merge 会合入用户尚未确认的内容。GitHub merge API 提供 [`sha` 前置条件](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request)，仅靠两步 UI 确认无法替代它。现有 [`isRepositoryWrite`](../../src/session-directory.ts) 还是静态端点集合，新增 `remote-*` 不会自动受到现有会话仓库写入校验。

建议 merge 必须携带用户确认的 head SHA，冲突后刷新并重新确认；review 明确绑定展示过的 commit，评论/close/create 也应携带并校验不可混淆的 provider、host、仓库、对象身份及 auth generation。新端点逐项纳入 Host 的会话目录/仓库约束，切换工作区时取消尚未发送的写操作。已发送写请求遇到超时或取消应显示“结果待确认”并查询远端状态；尤其 create/comment/review 不可按普通网络错误自动重试，避免重复副作用。

验收：确认后 PR head 更新；切换工作区/账号后旧请求入队；服务端已创建评论但响应丢失。三者分别应拒绝过期 merge、阻止错对象提交、保留可核对的未知结果。

#### R6 · P2 · 逐操作发现链仍可能重现子进程风暴，匿名轮询也没有足够预算（Decision 3、4、7；Consequences）

没有 grant/env token 的用户，每个 REST 操作仍可能启动 `gh` 与 Git helper；分页、详情中的多个端点及多会话轮询会放大该次数。将传输从 `gh` 换成 `fetch` 并未消除这条高频路径。匿名公共仓库即使只轮询一个端点，60 秒一次已接近 60/h 总预算，再加详情/手动刷新就会超额。且 [304 免主限额有正确认证的前提](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests)，不能套用到匿名模式；搜索与 secondary rate limit 也不能按统一 5000/h 处理。

建议先定义“一次操作”的边界：同一用户动作/分页序列共享一次发现，credentials ref 仍逐操作解析；capability 探测不运行 CLI、不发 GitHub 请求。对自动 CLI 发现频率作明确限制，若与“不跨操作缓存”冲突，应在 ADR 中选择可验证的方案。Host 按 host/身份/仓库共享读取与轮询预算，匿名模式采用手动刷新或更低频策略，遵守 `Retry-After`、reset、`X-Poll-Interval`，设置重试与分页上限。ETag 与响应正文需一起按身份和完整查询键隔离。

验收：多个会话打开同一仓库、多页列表、匿名用户、凭据缺失、429/secondary 403、缓存后 304；检查 REST 次数及子进程次数，而不只检查 UI 结果。

#### R7 · P2 · credentials 引用优先级不是所有支持版本上的同一契约（Decision 4、11；Consequences）

本地 `dsh-credentials@0.2.0-rc.2` README 明确启动环境变量优先且不可覆盖；`0.2.1-rc.2` 类型则明确 provider-managed store 优先、环境作为 fallback。因此正文的 `store > env > .env` 不能同时作为最低可用版与新版的统一保证。结果是同名 ref 在两个宿主版本可能解析为不同账号；本插件应尊重 `resolve` 返回的实际 source，避免自行复制或在 UI 承诺固定层级。

另外，当前 [`compat:check`](../../scripts/check-dsh-compat.mjs) 要求每个 DSH peer 的范围等于完整宿主清单，并拥有开发 pin；credentials 是后引入的可选能力，直接添加 optional peer 还需定义缺包旧车道、已发布版本子集与旧宿主装载验证，不能只增加 seam 探测。对跨进程刷新安全的表述也应保留上游的“backing store 支持时”条件，而非仅凭两个方法存在就保证所有 provider 都具备该能力。

验收：最低可用版与新版分别设置同名 store/env 值；旧宿主完全没有 credentials 包时验证安装、Host/Client bundle 装载及本地 Git；credentials mount/unmount 验证在途登录、请求、定时器均被清理，核心 UI 保留。

#### R8 · P2 · GitLab state 映射有误，provider 抽象还缺操作能力边界（Decision 6）

`merged ↔ opened` 会把已合并 MR 映射成仍开放；[GitLab MR API](https://docs.gitlab.com/api/merge_requests/)分别定义 `opened`、`closed`、`merged`（以及 `locked`）。中立模型应明确 `open/closed/merged`，GitHub 需结合 PR 的 merge 信息区分 closed 与 merged，GitLab `opened` 只映射 open。

建议 provider 除路径/标签外，还拥有认证与 host 配置、分页/错误归一、逐动作 capability、review/讨论语义和 head/base 仓库身份；共享层按操作接口调用，避免让 UI 拼 API 路径。GitHub 首期仅接受明确允许的 host/API origin；remote URL、分页/重定向 URL 与 `html_url` 各自校验用途，不能因“预留自建实例”就把现有 token 发给任意 host。自建实例 host-id 还需无碰撞编码规则，而非简单把标点替换成连字符。

验收：用纯数据 fixture 验证 open/closed/merged、fork head/base、未知能力；用传输 mock 验证陌生 origin 不接收 Authorization。GitLab 实现仍留在后续范围。

### 冻结设计前的补充项

- **明确首期验收边界。** “对齐 VSCode/IDEA 能力面”不足以估算与验收。把 Issue（只读还是 CRUD）、普通评论/行内评论、review（整体 approve/request changes/comment 还是含行定位）、create PR（现有远端分支还是包含 push/fork）、通知触发与去重分别列入需求；不做 Review Mode 并不自动回答是否要做 PR 文件比较或行内评论。大型实施计划按仓库规则放入 `docs/plans/active/`，本轮评审不将其提前视为开工。
- **补齐 OAuth 协议与 payload。** 明确申请的 scopes 与功能对应、组织授权/SSO 拒绝呈现、payload schema version、client/app/host 绑定、access/refresh expiry，以及不可刷新的 token。Device Flow 必须处理 interval、slow_down、过期、拒绝、取消与重复登录。当前 [GitHub OAuth 文档](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)已支持 OAuth App expiring tokens，且 Device Flow 产物刷新不要求 client secret；因此“公共 client_id + Device Flow + 安全 RMW”方向成立，但应明确 App 的 expiring-token 设置或运行时选择，以及刷新失败后的重新授权状态，不能假定所有 token 都会带 refresh token。
- **冻结公开 RPC 与验收矩阵。** 给出 remote-capability 的无 seam/off、匿名、待登录、凭据失效、存储只读等状态与错误码；无 seam 时 capability 应仍能返回结构化 off，其余 remote 操作明确拒绝。分别用 mock HTTP/credentials/subprocess 测试认证与 REST，用临时 Git 仓库测试 checkout，用 Client 生命周期测试验证 provider 卸载、工作区/账号切换及过期响应。按 Related Documents 的落点在实际实现变更中同步需求、架构、README 双语与兼容契约；本 ADR 保持 Proposed，不能以它的存在单独宣称新功能已可用。

本轮校验：只读核查现有实现与依赖契约；临时环境复现 askpass 行为；追加本节后运行 `pnpm docs:check`。未进行真实 OAuth、GitHub 写入或完整兼容矩阵运行。

### 2026-10-21 评审意见处理（拟议）

以下是对 R1–R8 与三项冻结补充的处理方案；复核通过后，相应条目视为对 Decision 正文的修订（在方括号处注明被修订项）。仍为拟议，不代表已实现。

#### R1 → 修订 Decision 1、2、9：capability 拆分为四个正交事实

`remote-capability` 响应分层返回，互不推导：

- `credential`：`{ configured, writable, source? }`——纯存储事实（`describeRecord`/`describe`），不声称任何认证或权限；
- `auth`：`{ state: 'off' | 'anonymous' | 'unauthenticated' | 'signed-out' | 'authenticated' | 'invalid', source?: 'grant' | 'ref' | 'gh' | 'git-credential' }`——`invalid` 专指"解析到的凭据经 401 验证失效"，与"没有凭据"是不同状态；
- `viewer`：经 `GET /user` 验证的 `{ login, id, name, avatarUrl }`，按 authGeneration 缓存，每个 generation 至多验证一次；
- `permissions` 与逐动作 capability：`{ pull, triage, push, maintain, admin }` 原样透传 `/repos/{o}/{r}`；`canComment / canReview / canMerge / canClose / canCreatePr` 为三态 `true | false | 'unknown'`——`canMerge` 取 push 位，`canComment`/`canReview` 在已认证且仓库可达时为 `true`、证据不足时为 `unknown`（UI 乐观可用、服务端裁决），`canClose` = 本人作者或 push 位。**绝不**用凭据 `writable` 或仓库 push 位一刀切所有写动作。

门禁改为探测实际调用的全部方法（`readRecord`、`modifyRecord`、`deleteRecord`、`resolve`、`describe`、`describeRecord` 及 `record-updated` 发射面），缺一即 off 并给出 reason，不做逐方法降级。

#### R2 → 修订 Decision 4、5：登出 = 持久抑制 + auth generation

- 语义拆两个动词：`revoke`（`deleteRecord`，仅删授权记录）与 `sign-out`（同 key 覆写 `{ kind:'grant', payload:{ v:1, state:'signed-out', at } }`）。后者是**持久抑制态**：发现链全停、capability 报 `signed-out`、UI 给"重新登录"入口；重启后仍有效，重新登录经 `modifyRecord` 覆写清除。临时"只想用回 env"用 revoke，两个动作在 UI 分开命名。
- `authGeneration`：Host 内存单调计数，`record-updated`、登录完成、登出、provider unload 时递增。Device Flow 完成写回前核对 generation，过期结果丢弃；capability 响应携带 generation；**写端点要求 `expectedGeneration` + `expectedViewer`**，Host 逐操作 resolve 后核对——确认框展示的是账号 A、提交时 resolve 到账号 B 即拒绝。
- 凭据 invalid（401）→ `invalid` + 修复提示，**不回退**到下一发现源（回退即换身份）。匿名仅在从未存在凭据时被选择。
- provider unload：停轮询、取消在途请求与 device-flow 轮询、清按账号键控的全部缓存、递增 generation。

#### R3 → 修订 Decision 4：`credential fill` 移出后台发现链

- 后台发现链收缩为：GrantRecord → `resolve(GH_TOKEN/GITHUB_TOKEN)` → `gh auth token` → 匿名。`gh auth token` 是纯本地无网络命令，但仍是子进程——只在**身份建立事件**（seam mount、`record-updated`、用户点"重新尝试"、401 失效后重解析）触发，串行、每事件至多一轮，不进逐 REST 操作路径。
- `git credential fill` 改为**用户显式动作**（"使用 Git 凭据"入口），调用契约：`GIT_TERMINAL_PROMPT=0`、`GIT_ASKPASS=<process.execPath>`（git 以 `askpass "prompt"` 形式调用——node 把 prompt 当脚本文件加载即非零退出，无 UI、跨平台、无 shell）、`SSH_ASKPASS_REQUIRE=never`、`GCM_INTERACTIVE=never`、`-c credential.interactive=never`；硬超时（≤5s）+ AbortSignal + 输出上限。helper 仍启动自身交互则超时终止并显式报错。
- 凭据探针走独立错误类型：stdout/stderr **不**进入 `GitCommandError` 式透传，不进日志与 RPC 错误体。

#### R4 → 修订 Decision 8：私有 ref 暂存 + SHA 核验 + 冲突拒绝

- 抓取与检出分两步：`git fetch <remote> +<provider.headRefspec(n)>:refs/dsh-git-remote/pr/{n}`（私有命名空间，不在 `refs/heads` 下，不可能与用户分支同名）→ `rev-parse` 核验落地 SHA 等于 API 返回的 `head.sha`；不一致即上游 race，刷新后重试。**先核验、后进入**，不自 Git 引文反推。
- 分支策略区分来源：同仓库 PR 以真实分支名建 tracking 分支（`git switch -c <head> --track <remote>/<head>`），本地同名分支 SHA 不同→拒绝并说明（不移动/覆盖用户分支）；fork PR 建 `pr-{n}`（不带 upstream），同名同 SHA→直接 switch，同名异 SHA→拒绝并给手动命名入口。目标分支已在另一 worktree 检出→透传 git 错误并建议经既有 worktree 入口进入。
- Git 传输认证边界**明确不桥接**：插件 OAuth token 不进入 git 子进程（不嵌 remote URL、不写 askpass shim——argv/日志泄露与便携性风险）；私库 fetch 依赖用户既有 git 凭据（helper/SSH）。capability 与失败提示区分"平台认证 OK / git 传输未认证"两种状态。

#### R5 → 修订 Decision 9：写操作带对象与身份前置条件

- merge 必带 `expectedHeadSha`（确认框展示的 `head.sha`）→ GitHub `sha` 前置参数；409/422 head 已动 → 刷新并重新确认。review 提交带 `commit_id` = 展示时 head SHA，绑定"审阅的就是这个提交"。
- 全部 `remote-*` 写端点 payload 携带 host/owner/repo/对象号 + `expectedGeneration` + `expectedViewer`；并**逐个加入** `isRepositoryWrite` 静态集合（受会话仓库断言保护）；工作区切换取消尚未发出的写。
- 已发送写遇超时/取消 → 返回"结果待确认"态，Client 触发定向刷新对账；create/comment/review/merge 不按网络错误自动重试（副作用不可重放）。

#### R6 → 修订 Decision 3、4、7：操作边界与预算

- "一次操作"边界：seam `resolve`/`describe*` 逐操作调用（进程内廉价读，守上游"不跨操作缓存"约定）；subprocess 探针仅在身份建立事件（R3）出现；capability 探测**零子进程零网络**，只报运行时已知事实。
- 轮询预算：匿名=仅手动刷新（不自动轮询；60/h 预算撑不起轮询）；认证 ≥60s 或遵从 `X-Poll-Interval`/`Retry-After`/reset；429 与 secondary-rate-limit 403 指数退避；分页有硬上限。缓存键含 (host, viewer, repo, 完整查询串)；正文"304 不占主限额"表述修正为**仅适用认证流量**。

#### R7 → 修订 Decision 4、11：不承诺固定分层 + matrix 接入

- 正文 `store > env > .env` 改写为：ref 解析分层由 provider 定义，本插件以 `resolve().source` 为准如实展示，不在 UI 承诺固定层级；同名 ref 在不同宿主版本解析出不同值属上游契约差异。RMW 表述加"backing store 支持时"限定。
- optional peer 接入沿用 `0.1.7-rc.2` util-code-language 先例：仅当目标 lane 存在该精确版本才写 devDep；无包旧车道验证安装、Host/Client bundle 装载与本地 Git 回归；credentials mount/unmount 清理在途登录、请求与定时器、保留核心 UI。

#### R8 → 修订 Decision 6：state 映射与 provider 边界

- 中立模型 `state: 'open' | 'closed' | 'merged'` + `raw` 原值透传。GitHub：`closed` 且 `merged_at` 非空 → `merged`；GitLab：`opened/closed/merged` → 同名，`locked` → `closed`（`raw` 保留 `locked`）。
- provider 接口除路径/标签外拥有：host allowlist、认证头形态、分页/错误归一、逐动作 capability、review/讨论语义、head/base 仓库身份。UI 只调操作接口，不拼 API 路径。
- token 只发往 provider 白名单 API origin；分页 Link、重定向、`html_url` 逐一同 origin 校验后才跟随或展示。自建实例 host-id 的无碰撞编码规则留为 GitLab/GHES 落地时的开放项（记入 plan 非冻结项）。

#### 冻结补充项的对应

- **首期验收边界**（拟定，待确认）：Issue = 列表+详情+评论只读+一键开分支，不含 issue 写操作；评论 = PR 级 + 行内（挂 diff，position 映射）；review = approve/comment/request-changes 含行内评论、`commit_id` 绑定；create PR = 已推送远端分支（含 fork head），创建流程内不做 push（引导走现有 push RPC）；通知 = review 请求 / 自己 PR 的 merged·closed·changes-requested / push 后建议建 PR，按事件 id 去重；PR 文件比较保留（不做 Review Mode ≠ 不做 diff 浏览）。
- **OAuth 协议与 payload**：申请 `repo` scope（私库读写必需；组织 SSO 拒绝的错误单独呈现引导授权）；payload `{ v:1, accessToken, refreshToken?, tokenType, scope, expiresAt?, login, host }`；App 是否开 expiring tokens 运行时兼容——无 `refreshToken` 的 token 到期转 `invalid`+重新授权；device flow 处理 interval 递增、`slow_down`、code 过期、`access_denied`、用户取消与重复登录互斥。
- **RPC 与验收矩阵**：capability state ∈ `off | anonymous | unauthenticated | signed-out | authenticated | invalid`，附 `storageWritable`；写路径错误码含 `remote-unavailable / unauthenticated / signed-out / insufficient-scope / head-moved / rate-limited(resetAt) / write-result-unknown`；测试 = mock HTTP（含 304/429/secondary）、mock credentials seam（含只读 store）、临时 git 仓库 checkout 矩阵（全新/落后同名/已有 pr-N/force-push/多 worktree/仅插件已认证的私库失败提示）、Client 生命周期（provider 卸载、工作区与账号切换、过期响应丢弃）。

### 2026-10-21 处理方案复核

**结论：五项产品/架构取舍大体可保留，但处理方案尚未完全闭合，ADR 继续 Proposed。** 本节是复核意见，保留上节拟议文本，尚不将其自动视为通过。

| 取舍 | 复核意见 |
| --- | --- |
| 同 key 持久 `signed-out` GrantRecord | 保留。重启仍登出符合该动作语义；`credential.configured=true` 可以表示“存在记录”，UI 必须按 `auth.state` 呈现，不能显示成“已授权”。只读 store 的登出须明确持久化失败或显式采用会话级抑制，不能报告持久登出成功。写回互斥见 F3。 |
| `GIT_ASKPASS=process.execPath` | 建议替换为空字符串环境变量，见 F4；不能把 Host 可执行文件等同于 Node CLI。 |
| 同仓库真实分支 + tracking、fork `pr-{n}`、异 SHA 拒绝 | 保留命名及保守冲突策略，不自动移动已有分支。必须先修复 F1，确保实际检出的就是核验过的 SHA。 |
| Client 携带 `expectedGeneration + expectedViewer` | 保留接口方向，Host 仍是校验真源。generation 必须绑定实际解析出的凭据与运行时实例，见 F2。 |
| Issue 只读 + 开分支、含行内评论/review、create PR 不包含 push | 保留范围，无需扩缩。行内评论需要独立的远端 diff 坐标模型，见 F6；实现计划需计入这部分成本。 |

#### F1 · P1 · 私有 ref 验证成功后，tracking checkout 仍可落到旧提交（处理方案 R4）

上节只显式 fetch `pull/{n}/head` 到私有 ref，却用 `<remote>/<head>` 创建 tracking 分支。后者未保证被此次 fetch 更新，与刚核验的私有 ref 不是同一个起点。本轮在两个临时仓库中复现：先 clone 旧 feature、切回 main 并删除本地 feature，再让远端 feature 与 PR ref 前进；按上节显式 refspec fetch 后，私有 ref 等于新 SHA，而 `git switch -c feature --track origin/feature` 仍检出旧 SHA。全新 clone 若只有单分支 refspec，还可能根本没有该 tracking ref。

建议分开“分支起点”和“upstream 配置”：从核验过的私有 ref/精确 SHA 创建分支，随后显式配置 tracking 所需 refspec/upstream；若选择更新 remote-tracking ref，必须同样核验其与目标 SHA 一致，再创建/切换。已有同名分支同 SHA 时还要检查 upstream 是否指向期望的 remote/head，不能静默改写另一个 tracking 关系。私有 ref 也应包含 base 仓库身份，避免同一检出配置两个远端、二者都有 PR #1 时共享暂存地址。

验收加入“私有 ref 新、origin/head 旧”和 single-branch clone；成功回执前实际 HEAD 必须等于目标 SHA。命名冲突仍沿用拒绝策略，不以覆盖分支来修复此问题。

#### F2 · P1 · 逐操作 resolve 与按 generation 缓存 viewer 之间缺少凭据变化检测（处理方案 R1、R2、R5、R6）

目前 generation 递增源只列出 `record-updated`、登录/登出与卸载，未包括 ref 的 `credentials/reference-updated`，也没有规定对 resolve 返回值的变化进行检测。当 `GH_TOKEN` 对应 ref 从账号 A 的 token 改为 B 时，generation 可能不变，viewer 缓存仍是 A。Host 即使逐操作 resolve 到 B，再拿缓存 A 与 `expectedViewer=A` 比对，也会通过，最后以 B 发出写请求。一次运行时内的单调计数还会在 Host 重启后重用，不能独立标识旧 Client 请求。

建议 Host 对每次实际解析出的凭据上下文（host、source、token 值的进程内不可逆指纹）进行变化检测，并监听相关 ref/record 事件；变化即失效 viewer、权限与缓存，重新验证身份后才允许写。指纹不跨 RPC、不落日志。generation 可用“运行时随机实例标识 + 单调 revision”表示；`expectedViewer` 使用 host + 稳定用户 id，login 只展示。写请求解析一次凭据快照，用该快照完成身份核对与后续 API 调用；确认后上下文已变则拒绝，由 Client 刷新后重新确认，不能再解析另一份 token 来发送写。

另外，加入 `isRepositoryWrite` 只会验证本地 `repository` 与会话目录一致；当前 [`assertSessionRepository`](../../src/session-directory.ts) 不核对 payload 的 host/owner/repo。新增 Host 逻辑还必须将这些远端身份绑定到本地选定 remote（create PR 的 fork head/base 则显式建模），不能把本地路径断言当作远端身份验证。

验收：同 generation 下替换 ref token、同账号换权限不同的 token、重启后旧请求重放，以及本地路径正确但 payload 指向另一个远端仓库；分别验证失效/重新确认或拒绝。

#### F3 · P1 · 登录写回前在锁外检查内存 generation，仍可能覆盖登出 marker（处理方案 R2）

`modifyRecord` 的安全点是 mutate 回调拿到锁内最新记录。若“写回前核对 generation”发生在调用它之前，登出可在检查后、拿锁前发生；另一个 Host 进程的 record 事件也可能尚未送达。此时旧登录仍会无条件覆盖新的 `signed-out` marker。持久化 marker 的选择合理，但仅有本进程计数不足以保护它。

建议给持久授权状态/登录尝试定义不可复用的 revision 或 nonce。登录开始时，在 `modifyRecord` 内建立尝试的预期状态；Device Flow 完成、刷新 token 写回也在 mutate 回调内比较最新记录与预期 revision，匹配才替换。登出生成新 revision 并清除旧凭据，显式重新登录才创建新的 attempt；旧进程/旧尝试不得靠“当前还是 signed-out”这样的枚举值判断获准写回。marker 的 `at` 仅作展示，不能单独当唯一 revision。

验收：受控阻塞 mutate 获取锁，在锁外检查后插入 sign-out；另用两个调用者模拟旧登录与新登出、两次显式登录交错，验证旧结果不能恢复授权。上节 `revoke=deleteRecord` 实际只清本地记录，UI 应命名为“清除本地授权/恢复自动发现”；若使用“撤销授权”，需明确并未在 GitHub 服务端撤销 token。

#### F4 · P1 · `process.execPath` 不具备必然立即失败的 askpass 契约（处理方案 R3）

Host 允许运行在 Desktop；文档没有保证其 `process.execPath` 一定是标准 Node CLI。在 Electron 宿主中它可能是应用可执行文件，重新执行可能启动应用；[Electron 的 Node 模式](https://www.electronjs.org/docs/latest/api/environment-variables#electron_run_as_node)需要专门的环境变量且受 fuse 限制。因此“node 把 prompt 当不存在的脚本，立即退出”不能作为 portable Host 设计前提。本轮未启动 Electron 验证具体宿主行为，该风险来自未成立的运行时前提。

更直接的方案是明确传 `GIT_ASKPASS=''`（空值保留，不能删除此环境变量），同时保留 `GIT_TERMINAL_PROMPT=0`。当前 [Git `prompt.c`](https://github.com/git/git/blob/master/prompt.c) 只有环境变量不存在时才回退 `core.askPass`/`SSH_ASKPASS`，空字符串会跳过整个 askpass 执行路径。本轮在 Git 2.56.0 下设置会留下标记的 `core.askPass` 与 `SSH_ASKPASS`，并设置空 `GIT_ASKPASS`，结果 exit 128 且两个 askpass 均未被调用，不需要新可执行文件。

仍须验证 subprocess provider 保留空字符串覆盖，以及支持的 Git/三种 OS；helper 自己的交互策略、用户显式触发与超时约束继续保留。超时只能终止/限制在途过程，不能保证 helper 已显示的 UI 从未出现，用户文案不能承诺任意 helper 都绝不弹窗。

#### F5 · P2 · API URL 与网页 URL 不能共用“同 origin”判断（处理方案 R8）

GitHub REST origin 是 `https://api.github.com`，PR/Issue 的 `html_url` 通常是 `https://github.com`。若对三类 URL 都要求与 API 同 origin，正常的“在浏览器打开”会被拒绝；若反过来为网页放宽所有 URL，Authorization 的边界又会扩大。

建议 provider 分别声明 API origin 与网页 origin。分页/带认证 API 重定向只按 API 策略验证；`html_url` 按 HTTPS 网页 allowlist 打开，不携带 token；Device Flow verification URL 也采用明确的授权网页策略。GitLab 映射表也应明确写成 `opened → open`，避免“同名”与中立模型的 `open` 字面量冲突。

#### F6 · P2 · 行内评论保留，但应使用新坐标接口并保存原始远端坐标（冻结范围）

[GitHub review-comment API](https://docs.github.com/en/rest/pulls/comments#create-a-review-comment-for-a-pull-request)已将 `position` 标记为将退出使用，推荐 `line`/`side`，多行附 `start_line`/`start_side`。新功能不应以旧 position 为公开定位契约。现有 [`gitFileComparison`](../../src/client/git-diff-adapter.ts) 会将 hunk 转换成文本片段，未保留原始 old/new 起始行；旧宿主还会拆开上下文，因此不能用渲染片段的行号反推出 GitHub 文件行号。

建议远端 diff 模型保存 path、base/head SHA、old/new 原始行号与 side，渲染层只引用稳定锚点；`commit_id` 与这些锚点来自同一比较快照。删行、重命名、多 hunk、过期线程、多行范围和 patch 缺失/截断时分别验收；无法可靠定位的内容可以浏览但禁用行内提交并说明原因。该要求不改变已选首期功能范围，只明确其实现边界。

本轮验证：临时仓库复现 F1；Git 2.56.0 临时环境验证空 askpass；核查 credentials seam 与当前 diff/session adapter；追加后运行 `pnpm docs:check` 与空白检查。未验证 Windows/Linux、真实 Desktop askpass、真实 OAuth 或远端写入，不能将本轮视为这些环境的通过记录。

### 2026-10-21 复核处理（拟议）

对 F1–F6 的处理如下；复核通过后视为对上节拟议及 Decision 正文的修订。仍为拟议，不代表已实现。

#### F1 → 修订 R4：分支起点必须是已核验 SHA，upstream 单独配置

- checkout 序列改为：`git fetch <remote> +<provider.headRefspec(n)>:refs/dsh-git-remote/pr/{repoKey}/{n}`（私有 ref 命名空间**包含 base 仓库身份 repoKey**——同一检出挂 origin+upstream 双远端且同号 PR 时不共享暂存地址）→ `rev-parse` 核验 == API `head.sha` → `git branch <name> <verifiedSha>` 或 `git switch -c <name> <verifiedSha>`——**起点只用已核验 SHA，不经 remote-tracking ref**。
- tracking 是第二步独立配置：同仓库 PR 在分支建立后 `git branch --set-upstream-to=<remote>/<head>`；该 remote-tracking ref 是否最新不参与起点判定。fork PR 不配置 upstream。
- 复用同名同 SHA 分支前，还须核验其 upstream 指向期望的 remote/head；不一致 → 拒绝，不静默改写 tracking 关系。
- 成功判据：checkout 完成后 `rev-parse HEAD` == 目标 SHA，方可向 Client 返回成功。命名冲突维持拒绝策略。
- single-branch clone（远端 tracking ref 可能不存在）与"私有 ref 新、origin/head 旧"进入验收矩阵。

#### F2 → 修订 R1、R2、R5、R6：凭据指纹 + 实例化 generation + 远端身份绑定

- Host 维护 credentialContext = `(host, source, fingerprint)`：fingerprint 为进程内不可逆摘要（如 SHA-256 截断），**不跨 RPC、不进日志**。每次解析出的凭据快照与之比较；不同即失效 viewer/permissions/ETag 缓存、递增 revision，重新 `GET /user` 验证后才放行写。`credentials/reference-updated` 与 `record-updated` 都监听，但事件只作失效提示，**真值以解析结果比较为准**（事件可能缺失或迟到）。
- generation 改为 `{ instanceId, revision }`：instanceId = Host 启动随机值（重启不复用，旧 Client 请求可识别），revision 单调递增；Client 持有的 generation 是不透明句柄。
- `expectedViewer` 改用 `host + user.id`（稳定数字 id）；login 仅展示用途，不参与校验。
- 写路径单一快照：一次 resolve 得到凭据快照，同一份快照同时完成身份核对与该次 API 调用；核对后发现 context 已变 → 拒绝并由 Client 刷新重确认，**不得再解析另一份 token 发写**。
- `assertSessionRepository` 只证本地路径一致；`remote-*` 写端点另加远端身份断言：payload 的 host/owner/repo 必须等于**从本地选定 remote（origin/upstream 聚合结果）解析出的远端身份**；create PR 的 fork head/base 建为显式模型字段，不接受任意字符串。

#### F3 → 修订 R2：revision/nonce 写进记录，锁内比较

- GrantRecord payload 增不可复用 `revision`（nonce）：登录尝试开始即在 `modifyRecord` mutate 回调内写入 `{ v:1, state:'authorizing', attemptId }` 占坑；Device Flow 完成与刷新写回也只在 mutate 回调内比较 `record.attemptId === 本尝试` 才替换；`signed-out` marker 携带新 revision，旧 attemptId 不匹配即丢弃——检查点在锁内，不靠锁外 generation 比较。
- `at` 仅作展示，不作 revision 依据。
- UI 动词改名：`revoke` → "清除本地授权（恢复自动发现）"，并注明不在 GitHub 服务端撤销 token；`sign-out` 保留持久抑制语义。

#### F4 → 修订 R3：askpass 采用 `GIT_ASKPASS=''`

- 放弃 `process.execPath` 方案（Host 可执行文件未必是 Node CLI，Electron 宿主前提不成立）。改为显式传 `GIT_ASKPASS=''`（空值覆盖，非删除），保留 `GIT_TERMINAL_PROMPT=0`、`SSH_ASKPASS_REQUIRE=never`、`GCM_INTERACTIVE=never`、`-c credential.interactive=never`、硬超时与输出上限。依据为 Git `prompt.c` 的空值跳过路径。
- 已在本机 Git 2.56.0 复验：`core.askPass` 与 `SSH_ASKPASS` 均设标记脚本时空 `GIT_ASKPASS` 使 `credential fill` 以 exit 128 失败且 askpass 未被调用（复核者也独立验证）。
- 待验项：所用 subprocess provider 是否保留空字符串 env 覆盖（`SubprocessSpawnSpec.env` 语义中 string 为覆盖、undefined 为删除——空串属合法覆盖值，实现时以测试锁定）；Windows/Linux 与真实 Desktop 行为列入验收矩阵。用户文案只承诺"已禁用 Git 侧提示"，不承诺任意 helper 绝不弹自带 UI。

#### F5 → 修订 R8：API origin 与网页 origin 分别校验

- provider 分别声明 `apiOrigin` 与 `webOrigin` 两条 allowlist（GitHub：`https://api.github.com` 与 `https://github.com`）。携带 Authorization 的请求（含分页 Link 与重定向跟随）仅校验 `apiOrigin`；`html_url` 与"在浏览器打开"按 `webOrigin` 的 HTTPS 校验且不携带 token；Device Flow 的 `verification_uri` 按授权网页策略校验。
- GitLab state 映射表显式写为 `opened → open`、`closed → closed`、`merged → merged`、`locked → closed`（`raw` 透传原值），避免与中立模型字面量混淆。

#### F6 → 修订首期范围（行内评论实现边界）

- 行内评论坐标改用 GitHub 现行 `line`/`side`（多行 `start_line`/`start_side`），不以已弃用的 `position` 为契约。
- 远端 diff 模型为每个片段保存 `path`、base/head SHA、old/new 原始行号与 side；渲染层引用稳定锚点而非反推行号；行内提交的 `commit_id` 与锚点取自**同一比较快照**。
- 删行、重命名、多 hunk、过期线程、多行范围、patch 缺失/截断列入验收；无法可靠定位的内容可浏览但禁用行内提交并说明原因。

本轮验证：本机 Git 2.56.0 复验空 `GIT_ASKPASS` 跳过 askpass 路径；其余仍为设计层处理，未做跨平台与真实远端验证。

### 2026-10-21 复核处理再审

**结论：F2、F4、F5、F6 在设计层通过；F1 的检出起点问题已闭合，尚需补齐 tracking ref 缺失时的步骤；F3 的登录尝试隔离成立，但 token 刷新协议还需明确。ADR 继续 Proposed。** 本轮只复核前述修改，不扩展功能范围，也不将设计层通过等同于实现或跨平台验证通过。

#### G1 · P1 · token 刷新不能仅以登录 attemptId 作为写回前置条件（复核处理 F3）

上节引入持久 revision，但实际写回条件只写了 `record.attemptId === 本尝试`。attemptId 适合判断某次 Device Flow 是否仍有效；同一次登录后的多次刷新却可能共享它，不能据此区分旧、新 token 版本。若两个进程都在锁外读到旧 refresh token 并调用刷新，再进入 mutate 比较同一个 attemptId，仍未保证旋转安全。[GitHub 刷新协议](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#refreshing-an-access-token-with-a-refresh-token)会让成功使用过的旧 refresh token 与旧 access token 失效，因此锁内“只比较后写回”不能代替最初要求的完整串行 RMW。

建议将登录和刷新明确为两条协议：

- **登录完成**：在 mutate 中验证 `state='authorizing'` 且 attemptId/预期 revision 匹配，写入 authenticated grant，并生成新的持久 revision；后续登录、登出和清除本地授权都使旧尝试失效。
- **刷新**：在 `modifyRecord` 的同一个互斥 mutate 回调内重新读取最新 authenticated grant，检查 revision、有效期与 refresh token；其他进程已经刷新则直接使用最新记录。仍需刷新时，使用锁内读出的最新 token，在同一互斥区间完成有界网络刷新及新 token 对的持久替换，并生成新 revision。不能先在锁外轮换 token，再仅靠写回 CAS 宣称刷新安全；若实现另选跨进程刷新租约，需把该协议完整写明。

验收应断言两个调用者同时发现到期时，同一旧 refresh token 只被用于一次刷新；第二个调用者读到新记录后不再使用旧 token，且旧刷新结果不能覆盖登出或新登录。这里需要明确的是正文既有“刷新经 modifyRecord 互斥 RMW”的完整含义，不新增认证功能。

#### G2 · P2 · single-branch clone 仍缺可执行的 upstream 配置路径（复核处理 F1）

本轮用临时仓库独立验证：`clone --single-branch --branch main` 后，将 PR 抓到私有 ref 并从正确 SHA `switch -c feature`，HEAD 正确；但随后 `git branch --set-upstream-to=origin/feature` 以 exit 128 失败，因为该 tracking ref 不存在。它不会因为本地分支或私有 ref 已建立而自动生成。仅把此场景加入矩阵还不足以定义成功行为，且此时本地已切换分支，不能把整个操作描述成无副作用的失败。

建议在修改本地检出前准备 tracking：确认允许跟踪的 remote/head，补齐缺失的 remote-tracking ref，并为 single-branch clone 明确增加该 head 的 fetch 映射（保留原有映射）；然后从已核验 SHA 创建分支并设置 upstream。另一种方案是明确该 clone 的 tracking 不受支持，并在切换前拒绝，但会缩小现有拟议范围。无论采用哪种方案，若分支已创建/切换而后续配置失败，回执必须报告实际 HEAD 与未完成步骤，不自动删除用户可能已开始使用的分支。

本轮验证：Git 临时仓库复现 tracking exit 128；核查最新处理文本及 GitHub 刷新契约；追加后运行 `pnpm docs:check`、空白检查。没有再次运行已通过的 askpass 试验，没有执行真实 token 刷新或远端写操作。

### 2026-10-21 再审处理（拟议）

对 G1、G2 的处理如下；复核通过后视为对上节拟议及 Decision 正文的修订。仍为拟议，不代表已实现。

#### G1 → 修订 F3/R2：登录与刷新是两条不同的锁内协议

`attemptId` 只管"哪次登录尝试有权写回"，不管 token 版本。刷新按其自身协议在**同一个** `modifyRecord` 互斥回调内完成全序列：

- **登录完成**：mutate 内验证 `state==='authorizing' && attemptId===本尝试` → 写 authenticated grant + 生成新 revision。登出、清除本地授权、新登录都使旧 attemptId 失效。
- **刷新**：mutate 回调内重新读取最新记录——非 authenticated 或 revision 不符 → 返回 `undefined` 原样保留（另一进程已改写，调用方读最新值即可）；`expiresAt` 尚有裕量（如 60s skew）→ `undefined`；确需刷新时，**使用锁内刚读出的最新 refreshToken，在同一互斥区间内做有界网络刷新并持久替换 + 新 revision**。后到者拿锁时读到的是新记录与新 refreshToken，自然不再使用旧 token——同一旧 refresh token 至多被用于一次刷新调用。
- 刷新失败分类：transient（网络/5xx/超时）→ 返回 `undefined` 不写，本次操作按凭据过期上报、下轮重试；`invalid_grant` 等永久失败 → 写 `{ v:1, state:'reauth-required', revision:新 }`——持久抑制发现链、UI 提示重新授权（不删记录：删了会落回发现链静默换身份；也不叫 signed-out——用户没有主动登出）。响应缺 `refresh_token` 时保留原值；无 `refreshToken` 的 token 到期同样转 `reauth-required`。
- 边界与限度：互斥区内的网络调用带硬超时与 AbortSignal，持锁时间有界；跨进程互斥以 backing store 支持为条件（R7 限定保留），不支持时退化为"重试并上报"而非声称已串行；不自建租约协议。

#### G2 → 修订 F1/R4：先备齐 tracking，再改本地检出

检出前准备全部前置（此前不动用户可见状态），按序：

1. 核验 payload 的 remote/head 属于本地 origin/upstream 聚合解析出的允许集合（远端身份绑定，见 F2 处理）；
2. fetch → 私有 ref `refs/dsh-git-remote/pr/{repoKey}/{n}` → 核验 == API `head.sha`；
3. **tracking 预备**：`refs/remotes/<remote>/<head>` 缺失或落后 → `git update-ref refs/remotes/<remote>/<head> <verifiedSha>` 由已核验本地对象直接补齐，不做第二次网络 fetch（消除两次 fetch 间分支移动的竞态窗口）；再检测 `remote.<name>.fetch` 映射——head 不在映射内（single-branch clone）→ `git config --add remote.<name>.fetch +refs/heads/<head>:refs/remotes/<remote>/<head>`（追加、保留原映射，使后续 `fetch <remote>` 持续覆盖该分支）；
4. `git switch -c <name> <verifiedSha>`（或复用同名同 SHA 分支——复用前同样先经第 3 步补齐再核验其 upstream）；
5. `git branch --set-upstream-to=<remote>/<head>`——tracking ref 已在第 3 步保证存在；
6. 中途失败回执：步骤 1–3 失败 → 无任何本地改动；步骤 4 之后失败（如 `--set-upstream-to` 竞态失败或 config 写入被拒）→ 返回实际 `HEAD` SHA 与未完成步骤标记（如 `upstreamNotConfigured`），**不自动删除**用户已能看见/使用的分支。整端点计入 `isRepositoryWrite`（含 config 写入）。

备选且否决：single-branch clone 拒绝 tracking——缩小范围且与本协议修复成本相当。

### 2026-10-21 再审处理复核（中断后重新核对）

**结论：G1 的锁内并发刷新主流程已闭合；G2 的 update-ref 方案可以保留，无需第二次 fetch。** 本轮未发现新的 P1，以下三项 P2 是新增处理中的并发保护、失败回执和保证范围修正。ADR 保持 Proposed；设计层通过不等于实现或跨平台验收通过。上次中断时本节尚未落盘，本节以重新核对后的证据为准。

#### H1 · P2 · 刷新“至多一次”保证需与网络失败重试规则一致（再审处理 G1）

同一个互斥回调已解决两个调用者同时使用旧 refresh token 的正常并发路径，无需重开 G1 的主方案。但“同一旧 token 至多被用于一次调用”与“所有网络/5xx/超时原样保留、下轮重试”不能同时无条件成立：服务端可能已经完成旋转，客户端却未收到响应。[GitHub 刷新协议](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#refreshing-an-access-token-with-a-refresh-token)规定成功刷新后旧 access/refresh token 失效；响应丢失时是否成功，客户端并不知道。成功收到 token 对但持久化失败也存在远端已生效、本地未提交的边界。

建议显式分开“确定未发出/未生效，可有界重试”和“结果未知”。对结果未知，推荐停止自动重放旧 token，提示重新授权并保持发现链抑制；若产品选择一次有界重试后根据 `bad_refresh_token` 等错误转重新授权，也必须如实声明 best-effort，不再承诺严格至多一次。持久化失败需单独上报，不能报告其他进程已被持久抑制。不支持跨进程互斥的 provider 也不能靠重试取得该保证，应明确自动旋转的可用前提。

验收补充：服务端已旋转但响应丢失、旋转成功但记录写入失败；验证重试次数、最终提示及不回退其他身份。本条是失败协议与保证范围的澄清，不表示锁内刷新设计仍有原来的并发漏洞，也不声称已复现真实 GitHub 的网络故障。

#### H2 · P2 · update-ref 需携带预期旧 SHA，防止覆盖检查后的并发推进（再审处理 G2，第 3 步）

“缺失或落后”的读取判断与无条件 `git update-ref <ref> <verifiedSha>` 之间仍有窗口：另一个会话或用户后台 fetch 可先推进相同 tracking ref，随后本操作将其写回较旧快照。本轮临时仓库重现了此交错：初始值确实落后于 verifiedSha，但检查后先写入更晚提交，无条件 update-ref 仍将其覆盖；使用预期旧 SHA 后 exit 128，较新值保留。

建议使用 [update-ref 的 old-oid 条件](https://git-scm.com/docs/git-update-ref)：已有 ref 带 observedOldSha，缺失 ref 带 Git 定义的“不存在”预期值；条件失败则有界重读判断。若 ref 已相同或领先，保留现值；分叉时不静默强改。checkout 始终从 verifiedSha 起步，tracking ref 不必为本次 checkout 回退到同一 SHA，因此无需第二次 fetch。该步骤表达“用已核验快照准备 tracking”，不代表重新查询并确认了远端 branch 的最新状态。

验收加入检查后后台 fetch 推进、缺失 ref 被另一个调用者创建、tracking ref 已领先或分叉；已有分支仍不得被自动移动。本轮也验证了成功路径：手工补 tracking ref、追加 head fetch 映射后，设置 upstream 成功，实际 HEAD 保持 verifiedSha。

#### H3 · P2 · 准备步骤失败的保证应限定为未改检出，而非无本地改动（再审处理 G2，第 6 步）

第 2 步 fetch、第 3 步 update-ref/config 已经写入仓库对象、ref 或配置。本轮在临时仓库 update-ref 成功后，用占用的 `config.lock` 令追加映射以 exit 255 失败；先前 ref 修改仍保留。因此“步骤 1–3 失败 → 无任何本地改动”不成立。

建议改为“准备阶段失败不创建/切换用户分支，不修改 index/工作文件”；回执从首次持久写入开始记录已完成阶段，包括私有 ref、tracking ref、fetch 映射是否变化。ref/config 不在同一事务中，不承诺跨二者原子回滚，也不盲目清理以免覆盖并发修改。切换前失败报告“未切换，准备部分完成”；切换后继续报告实际 HEAD 与未完成步骤。

本轮验证：四个临时 Git 场景分别确认无条件更新覆盖并发推进、old-oid 条件拒绝覆盖、config 失败保留 ref 修改、手工 tracking ref + 映射成功配置 upstream；核对 Git/GitHub 官方契约；追加后运行 `pnpm docs:check` 和空白检查。未执行真实 OAuth、远端写入或 Windows/Linux/Desktop 验收。

### 2026-10-21 H 组复核处理（拟议）

对 H1–H3 的处理如下；复核通过后视为对上节拟议及 Decision 正文的修订。仍为拟议，不代表已实现。

#### H1 → 修订 G1/F3：刷新失败按"是否已生效"分类，保证范围收窄为严格不重放

- 失败分三类处理，不再笼统"网络错误下轮重试"：
  - **确定未生效**（连接被拒/DNS/发送前即取消——请求未到达服务端）→ 有界重试（即时 ≤1 次 + 下轮自然重试）；
  - **结果未知**（超时/响应丢失发生在请求可能已到达之后）→ **停止自动重放旧 refreshToken**，在同一 mutate 内写 `{ state:'reauth-required', revision:新 }` 并提示重新授权，发现链保持抑制。服务端已旋转的极端情况下旧 token 已死，严格不重放是正确的；服务端未旋转时则需一次本可避免的重授权——为换取"同一凭据快照至多发起一次刷新交换"的严格保证接受此代价。据此正文不再承诺"所有网络错误可重试"；
  - **持久化失败**（服务端已旋转、`modifyRecord` 提交被拒）→ 错误如实上报"远端已更新、本地记录未提交"；本地留存的旧 token 下次使用必然被服务端拒（`bad_refresh_token`/`invalid_grant`）→ 走永久失败路径转 `reauth-required`，自然收敛，不虚构"已知远端状态"的回执。
- 跨进程互斥以 backing store 支持为前提（R7/G1 限定保留）；不支持时自动旋转不可用，该前提在 capability/文档中明示，而不是靠重试代偿。
- 备选且否决："结果未知时有界重试一次 + 依据 `bad_refresh_token` 判死"——必须以 best-effort 声明放弃严格至多一次，复杂度换来的只是少一次偶发重授权。

#### H2 → 修订 G2/F1：`update-ref` 带预期旧 SHA 条件

- `git update-ref refs/remotes/<remote>/<head> <verifiedSha> <expectedOldSha>`：ref 已存在 → `expectedOldSha` 取读到的当前值；缺失 → 取 Git 定义的全零"不存在"预期值。
- 条件失败（exit 128）→ 有界重读判断，分三种去向：当前值已等于 `verifiedSha` → 直接用；当前值领先于 `verifiedSha`（远端在两次读之间推进）→ 并入既有"上游 race → 刷新重试"路径而非强改；分叉（非祖先关系）→ 失败上报，不静默覆盖。
- 语义澄清：该步骤只表达"用已核验快照准备 tracking"，不代表重新确认了远端分支最新状态；checkout 起点始终是 `verifiedSha`，tracking ref 不为本次检出回退，因此仍无需第二次 fetch。
- 验收加入：读取后后台 fetch 推进、缺失 ref 被并发创建、ref 已领先、ref 分叉四类交错；已有用户分支不被移动的承诺不变。

#### H3 → 修订 G2/F1：失败保证限定为"未改检出"

- 措辞修正：准备阶段（fetch 私有 ref / `update-ref` / `config --add`）失败 → "**不创建或切换用户分支，不修改 index 与工作文件**"，替代不成立的"无任何本地改动"。
- 回执自首次持久写入起记录已完成阶段（`privateRefWritten` / `trackingRefPrepared` / `fetchMappingAdded`）；ref 与 config 不在同一事务，不承诺跨二者原子回滚，也不盲目清理以免覆盖并发写入。
- 切换前失败 → "未切换，准备部分完成" + 已完成阶段清单；切换后失败 → 实际 `HEAD` SHA + 未完成步骤标记（如 `upstreamNotConfigured`）。

### 2026-10-21 H 组处理复核与冻结评估

**结论：H2、H3 设计层通过；H1 的结果未知分类和互斥前提通过，但严格不重放的保证仍与持久化失败路径冲突。仅余原 H1 的一项 P2，不新增 P1。ADR 保持 Proposed，尚不能声明所有评审项已闭合。**

H2 接受用 expected-old 条件保护 tracking ref，遇领先值时有界刷新重试比直接保留更保守，但属于合理取舍；H3 已正确区分检出未变与仓库元数据部分完成。既定验收保留，不需再次调整架构。

**H1 剩余问题：被服务端拒绝的第二次请求仍然是重放。** 上节“持久化失败后，本地旧 token 下次使用被拒，再转重新授权”可以收敛到可解释的错误状态，却不能同时满足“同一凭据快照至多发起一次刷新交换”。反例不需要并发：进程 A 用记录 revision R 的 token 成功刷新，新记录提交失败；进程 B 或重启后的 A 再读到仍为 R 的记录，再次请求刷新。第二次虽失败，同一旧快照已发起两次交换。结果未知分支写 `reauth-required` 失败时也具有相同边界；崩溃发生在远端已执行、本地未提交之间时同理。

冻结前应明确采用下列哪一种保证，不能混写：

- **最小改动：有条件的不重放。** 只对刷新结果或抑制态已成功持久提交、且 backing store 提供互斥的路径保证跨进程不重放；提交失败后当前进程停止自动刷新并报告错误，明确跨进程/重启后的严格保证不成立。保留必须重新授权的产品取舍，无需新增存储协议，但不能称为覆盖持久化失败的严格至多一次。
- **坚持跨故障严格保证：先持久化发送意图。** 在发交换请求之前，成功提交一次性刷新尝试标记；其他调用者以及重启恢复看到未完成标记时不得再次使用该 token，只能等待已知在途结果或进入重新授权。标记无法持久提交则不得发送。成功后再提交新 token 对，失败后保留不重放证据。这仍可使用同一 GrantRecord，但需要明确准备/执行/完成的恢复协议，不能用“网络刷新后同一次 modifyRecord 的最终提交”代替发送前持久化。

前者是更小的契约修订；后者才能支撑上节期望的跨故障严格承诺。选择属于本 ADR 的保证范围，不要求重新评审已通过的 UI、checkout 或 provider 抽象。验收需加入远端刷新成功而本地提交失败、抑制 marker 提交失败、发送后提交前重启三类交错，并分别检查当前进程与第二个调用者的交换次数。

本轮核查依据为最新 H 组文本及持久提交顺序的协议反例；未执行真实 token 刷新或宣称实现已有该错误。追加后运行 `pnpm docs:check` 与空白检查，跨平台与实现测试仍按既定矩阵执行。

### 2026-10-21 冻结评估处理（拟议）

**选择：先持久化发送意图的跨故障严格保证（评审列出的第二方案）。** 它用同一 GrantRecord 的状态机表达，且把网络调用移出互斥锁——比 G1 的"锁内网络刷新"更轻。修订 G1/F3/R2 相应描述如下。

- GrantRecord payload 状态机扩为 `authorizing | authenticated | refreshing | signed-out | reauth-required`；每次持久提交携带新的不可复用 `revision`。
- 刷新为**两阶段**协议，两次提交都经 `modifyRecord` mutate 锁内 CAS：
  1. **prepare**：mutate 内判定 `authenticated` 且到期 → 写 `{ state:'refreshing', refreshId, basedOnRevision }`；**标记成功提交后才允许发送交换请求，提交失败则不发送**（本次操作按凭据不可用上报，下轮可重试 prepare——token 未被消费过，重试安全）；
  2. **execute**：marker owner 在锁外发送刷新请求（互斥锁不覆盖网络调用，持锁时间因此有界且不含网络往返）；
  3. **complete**：mutate 内验证 `state==='refreshing' && refreshId===本尝试 && basedOnRevision===R` → 写 authenticated 新 token 对 + 新 revision；状态已变（signed-out/新登录/reauth-required）→ 丢弃已收到的 token，不覆盖。
- **旁观与恢复规则**：任何调用者读到 `refreshing` 即视为"交换在途或已发生"——先按记录时间做有界等待（轮询记录，≤TTL）等 finisher 提交；超时仍未完成 → mutate CAS 转 `reauth-required`。**非 marker owner 绝不再用该快照发送**；进程在"marker 已提交、请求未发出"间崩溃同样按已燃烧处理——为严格保证接受的保守代价。
- **修订后的保证表述**："**一个可能被服务端消费过的凭据快照，绝不再次用于刷新交换**"。安全重试的唯一例外是**传输层能确认请求未发出**（连接未建立/发送前取消）。发送后的任何非确定性结果一律视为可能已消费：确定性拒绝（`invalid_grant`/`bad_refresh_token`）→ 转 `reauth-required`；结果未知——含超时、响应丢失与**任意 5xx**（网关 502/504 不能证明上游未执行，非 2xx 状态码不构成"未消费"依据）→ CAS 转 `reauth-required`，绝不重放。未来仅当 provider 对某类错误给出可引用的"未消费"保证时，才逐项加入例外。
- **complete 阶段持久化失败**：收到的新 token 对有效但未落盘 → 视为丢失丢弃；记录仍为 `refreshing`，旁观规则接管至 `reauth-required`；错误如实上报"远端已更新、本地未提交"，不虚构已持久化。
- 据此，G1 中"互斥区内做有界网络刷新"作废，替换为本节两阶段协议；"至多一次"的保证范围从"已持久提交的路径"提升为**覆盖崩溃、重启与持久化失败的全路径**，唯一不构成消费的例外是"请求确认未发出"。

验收增补（对齐评审要求）：远端已旋转而本地 complete 提交失败；`refreshing`/`reauth-required` marker 提交失败；发送成功后 complete 提交前进程重启；**上游已旋转但调用者收到 502/504**——断言不回退 `authenticated`、不重发旧快照——分别断言每个调用者的交换次数与最终状态；旁观者 `refreshing` 等待有界且不会自行重发。

### 2026-10-21 两阶段严格方案复核

**结论：prepare/execute/complete、先提交意图后发送、complete CAS、旁观恢复及 complete 提交失败路径在设计层通过。仅余原 H1 的一个 P2：5xx 被当作确定未消费缺乏契约依据。** 不新增 P1，也不重开其他已通过事项；ADR 仍为 Proposed。

上节“按 GitHub 契约，旋转只随成功响应发生”不能从本轮核查的 [GitHub OAuth 刷新文档](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#refreshing-an-access-token-with-a-refresh-token)推出：该文档说明成功使用 refresh token 后旧 token 失效，没有承诺所有 HTTP 5xx 都代表未旋转或已回滚。[RFC 9110 §9.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2)要求非幂等请求的自动重试有幂等语义或原请求未执行的依据；[502/504 的语义](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.6.3)只说明网关未取得有效/及时的上游响应，不能证明上游没有执行。

因此，协议反例为：上游已旋转 → 网关返回 504 → 当前规则将 refreshing CAS 回 authenticated → 重发旧快照。它仍违反已选择的“可能消费过绝不重发”。这是失败模型分析，不是对 GitHub 实际故障行为的观测。

**最小补正：删除以 5xx 状态码认定未消费的例外；发送后收到 5xx 同样按结果未知处理，CAS 转 reauth-required，保留不重放证据。** 安全重试例外仅保留传输层能确认请求未发出的情形；无法证明未发送则按未知。未来若 provider 的某个明确错误有可引用的“未消费”保证，再逐项加入，而不能从非 2xx 状态推断。本补正符合已选严格策略，无需改动两阶段架构。

验收增加“上游已旋转但调用者收到 502/504”，断言不回退 authenticated、不重发旧快照；其余既定矩阵保留。落实该单点补正后，本轮 H1 的设计问题即可闭合，无需再增加存储协议。冻结时还需将多轮修订归并为可直接执行的最终 Decision，历史评审保留；正式 Accepted 与实现完成仍是不同状态。

本轮只核查协议和官方契约，未执行真实 OAuth 或跨平台试验；追加后运行 `pnpm docs:check` 与空白检查。

### 2026-10-21 设计评审闭合确认

**结论：最新拟议条款已删除 5xx 安全重试例外，并将发送后的任意 5xx、超时、响应丢失统一归为结果未知；H1 闭合。本 ADR 已登记的 R/F/G/H 各组 P1、P2 技术设计评审项全部闭合，可以进入最终 Decision 归并与冻结评估。** 本结论是对最新拟议条款的复核结果；先前各轮问题与结论保留为当时状态的历史记录。

本轮核对了 prepare 提交失败不发送、锁外 execute、complete CAS、结果未知不重放、complete 提交失败保留 refreshing 证据，以及 502/504 验收断言，未发现需要重开设计评审的问题。这里的“闭合”不表示功能已实现、验收已通过或 ADR 已 Accepted；状态继续保持 Proposed，真实 OAuth、跨平台与实现矩阵仍按已登记要求执行。

**归并方式：采用重排，不再追加第二份并列生效的 Decision。** 将最终归并文本放入正文 `Decision`，作为唯一的拟议实施依据；原始 Decision 原文移入明确标注的“初始决策（历史）”，全部评审/处理记录按时间保留。归并版应完整吸收已采纳修订，消除硬门禁方法、发现链、权限字段、认证状态机、刷新两阶段协议、checkout/tracking 与失败回执中的旧表述；不能要求实施者再逐轮推导何者生效。此次仅确认归并规则，尚未执行重排或将状态改为 Accepted。

本轮 `pnpm docs:check` 与空白检查通过；没有新增实现代码或执行真实远端操作。
