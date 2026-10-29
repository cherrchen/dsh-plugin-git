中文 | [English](remote-platform-rpc.en.md)

# 远程平台 RPC 契约（remote-*）

- **Status**: Current（实现与 mock/临时仓库验证；真实 OAuth、远端写入及平台手工验收仍 Not verified）
- **设计权威**：[ADR-0004 Decision](../decisions/ADR-0004-remote-platform-integration.md#decision)（Proposed）与[实施计划](../plans/active/remote-platform-integration.md)。

## 门禁与生命周期

`/git` 通道在缺少完整 credentials seam 时整功能关闭：结构性检查 `readRecord`、`modifyRecord`、`deleteRecord`、`resolve`、`describe`、`describeRecord`、`notifyRecordUpdated`，允许原型方法，绝不调用事件发射方法。缺失成员只回传允许名单名称，getter/存储/进程/网络错误不透传 secret 或原始诊断。

Host 的 credentials 子 fiber 拥有认证、REST、缓存与子进程工作。卸载先停止准入并取消、等待在途工作；本地 Git service 和 Client Changes/Diff/Graph/Worktrees 保留。Client 主 fiber 每 5 秒探测 capability，按 on/off 注册、注销 `git.remote` type/body/title；请求按会话与仓库绑定，目录变化取消旧请求，账户/generation 变化丢弃旧数据。Desktop 子 fiber 增强通知、授权浏览器打开和用户码复制，不拥有核心 UI。

credentials 使用本地结构契约，无运行时或发布声明包导入，旧宿主无此包时仍能构建和加载。兼容车道见 [DSH 兼容契约](dsh-compatibility.md)。

## `remote-capability`

无 `remoteProtocol` 标记时 payload 仍被忽略（含 `null`）。无 seam 返回 `{ state:'off', reason:'credentials-missing', auth:{state:'off'} }`；不完整 seam 返回 `credentials-incomplete` 与 `missing`。`implementation-pending` 保留为运行时未装配时的安全兜底。

完整 seam 的无作用域应答保留 `{ state:'on', generation, credential, auth, actions, loginAvailable, automaticRefreshAvailable, authSelection? }` 并附加 `remoteProtocol:2` 宣告。capability 不启动子进程或网络，只读取存储描述与已知的内存认证状态。`credential.configured/writable` 不表示已认证或远端写权限；初始 `auth.state` 为 `unauthenticated`，动作是 `unknown`。仓库 viewer、permissions 与动作事实由 `remote-repository` 单独返回。

`generation = { instanceId:string, revision:number }` 对 Client 不透明；Host 重建时 instanceId 不复用。viewer 的稳定身份为 `{host,userId}`，login 仅展示。同一 generation 至多一次 `GET /user`；显式重试会创建新 generation，失败 token 不会因重试自动回退到其他账号。

## Scoped v2 基础（Current）

Host 在完整 seam 的无作用域 capability 中宣告 `remoteProtocol:2`；Client 只有看到该宣告才发送 v2。带标记请求必须为 `2`，除跨实例 `remote-repositories` 与孤儿清理外，都带 `{provider,instance}`。成功回 `{remoteProtocol:2,scope,generation,value}`；capability 的内外 generation 相同，无返回值为 `value:null`。seam off 和 RPC 错误是控制结果，不提供可信 generation。Client 校验标记、规范 scope 和 generation，丢弃乱序/过期应答；失败不回退为无作用域写入。GitHub 作用域为 `https://github.com`；v1 字段、grant 和无作用域调用保持原义。

v2 `remote-repositories` 带 `repository/sessionId?`，返回 `{remoteProtocol:2,value:{state,remotes,unresolved?}}`，每个已识别 identity 含 scope。只读取本地 origin/upstream、显式登记实例和内建 GitLab.com；陌生域名不探测。HTTPS 前缀和 SSH endpoint 分别匹配，同一 SSH 映射无法唯一归属时返回脱敏 `ambiguous`。未知 URL 不回传；无 seam 仍为全局 off。

无作用域 v2 `remote-accounts` 只接受 `{remoteProtocol:2}`（任何附加键按 invalid-request 拒绝），不需要会话或仓库；返回 `{remoteProtocol:2,value:{accounts}}`，列出 GitHub 固定项与每个已登记 GitLab 实例的 `{provider,instance,label?}`，不含 clientId、credentialRef、sshHost 等配置或秘密。有作用域 v2 `remote-account` 仅需 scope、不需要仓库：按首次读取相同的发现规则非交互建立身份，返回该 scope 的 `ScopedRemoteCapabilityOn`（认证时含 viewer）；GitHub 经旧 owner 的按 generation 共享 viewer 缓存读取，每 generation 至多一次 GET /user，未认证时不发网络请求。插件设置页的“平台账号”分区列出这些账号并打开与 Remote 页相同的认证对话框。

设置页打开时，进入页面和后续 capability 轮询都会重新发现实例列表；每次成功发现后，即使列表描述和全局 GitHub generation 不变，也会重读已显示的 GitLab 账号能力与 viewer，以反映同一 URL 的 App/ref 配置变化或实例 owner 重建。未挂载的账号、忙碌操作和等待中的 Device Flow 不触发后台账号重读；后台重读不会再次触发全局 capability 轮询。

GitLab 实例的 capability、`remote-login`、`remote-poll-login`、`remote-cancel-login`、`remote-sign-out`、`remote-clear-grant`、`remote-retry-auth`、仓库级 `remote-repository`、MR/Issue 列表与详情、commits、notes、discussions、审批事实、文件比较、MR checkout、Issue 分支及受守护的 MR 评论/审批/创建/关闭/直接合并 Host 端点已接线。`remote-repository` 接受本地仓库及完整 `path`、可选 `projectId` 和对象 `{kind,number}`，先匹配本地 origin/upstream 的实例和路径，再请求项目并核对 API 的 `path_with_namespace` 与 id；各页发送前及响应返回前再次核对本地 remote 与会话，并在返回前核对认证 generation。返回的 `actionScope` 标明仓库或对象，`operationSupport`、方法/事件集、动作与 `reviewPermissions` 分别表示实现/策略和权限事实；未知权限不表示拒绝，未确认项目功能或方法不开放。未实现的远端写入仍拒绝 `git/remote-unavailable`，不会伪造成功。项目身份读取不缓存；对象读取只在认证时按实例、viewer、generation、项目与完整请求路径隔离缓存，有 ETag 才发送条件请求。匿名只接受手动请求，认证自动请求至少间隔 60 秒并服从限流。实例 capability 动作仍为 false；`authMethods.deviceFlow` 初始为 unknown，显式尝试可更新为已支持/不支持。capability 只读存储描述与内存状态，不启动网络或子进程。`remote-retry-auth` 显式验证身份并可读取实例 metadata；成功读取的 `serverVersion` 标为 `support:'unknown',reason:'not-verified'`，不构成服务端兼容承诺。元数据不可用不会把已验证身份改成另一个账号；认证 401 仍标 invalid。

每个 GitLab 实例独立 grant v2、App、viewer、随机 generation、请求和登录 attempt。发现顺序、ref 绑定/失败分类、URL 和 838 字符上限以[设计 D2/D4](../architecture/remote-platform-instances.md)为准。Device Flow 只发送 `api` scope 和实例 App；访问 token 只发往选定实例 `<prefix>/api/v4/`，OAuth 与验证页分别限定路径，不带 REST bearer。响应缺 `expires_in` 不提交 token；仅在部署方对**实际 store** 的跨进程互斥作 `refreshStoreExclusive` 正向保证且有 refresh token 时自动刷新。持久意图/CAS 和未知结果不重放；新响应缺 refresh token 时不复用旧 token。项目查询仅允许从已核验本地路径生成的精确编码路径，其他 API 路径仍拒绝百分号编码；逐跳重定向受到原请求约束。列表续页使用 Host 管理的随机 handle，绑定实例、项目、viewer、generation、查询及会话；单次最多 10 页，超出以 handle 继续，分页头缺失则报错而不宣称完整。分页 Link 的路由回显 `id`、`noteable_id`、`merge_request_iid` 按当前项目/对象路径核对；仅允许该端点已验证的默认查询值，拒绝未知或重复的附加参数及查询变化。校验后只从原 Host 查询与已验证页码构造续页，不转发服务端补入的参数；first/last/prev 同样校验作用域，next 必须恰好前进一页。MR/Issue 区分全局 id 和项目内 iid；MR 保留 source/target project、分支与实际提供的 SHA，`locked` 投影为 `open` 并保留原值，未知状态只读。配置完整校验后更新注册表：无效更新保留上一份有效快照；首次配置无效时保留内建 GitLab.com 与 GitHub 发现，退役在配置无效时拒绝；变更/移除的 context 取消并 drain。宿主 volatile 引用没有订阅接口，Host 以一秒周期对账，并在认证关键步骤及 scoped 响应前复核。

GitLab 的 `remote-comments` 和 `remote-discussions` 需带 `objectKind:'pull'|'issue'` 与项目内 `number`；前者返回只读独立 notes，notes API 顺带回显的 DiffNote/DiscussionNote 及可 resolve 的 discussion 成员在此排除；后者只返回真实 discussion（GitLab 对每条普通 note 额外包装的 `individual_note` 项在此排除，避免同一 note 既作评论又作线程重复呈现），返回独立 discussion id、notes 及可得的 resolved/resolvable 和 diff position（含双侧路径/行号、base/start/head 与 line range），不以 review id 代替线程。`remote-approvals` 返回 API 实际提供的当前审批字段和批准者，不生成 review 历史。`remote-files` 首次和续页均复核 MR 比较快照；续页带 `expectedBaseSha`、`expectedStartSha`、`expectedHeadSha`，游标同时绑定三者。快照变化返回 `git/head-moved`；collapsed、too-large、空或缺失补丁分别显式标识。上游 diff 限制可能独立于分页截断文件，故 `serverCompleteness:'unknown'` 始终明确保留这一限制；`files.truncated:false` 只表示没有更多分页链接，不证明服务端提供全部变更。GitLab 的 `remote-reviews` 和 inline 评论提交仍不可用。

GitLab 的 `remote-checkout-pr` 与 `remote-issue-branch` 要求规范 `expectedInstance`、`expectedGeneration`、稳定 `expectedViewer` 和 `requestId`，由 Host 重新解析项目与对象并在每个本地副作用前核对会话、remote 和凭据快照。checkout 只从匹配的 origin/upstream 读取目标项目 `refs/merge-requests/<iid>/head`，写入按实例和目标 project id 隔离的私有 ref，再与 API head SHA 核对；同库设置 source tracking，fork 默认 `mr-<iid>`，已有默认分支时要求改名。回执分别记录私有 ref、tracking、fetch mapping、切换、upstream 和实际 HEAD 的已知状态；观察到其他 worktree 占用分支时附 `worktreeConflict:true`。不自动回滚或删除分支。Issue 分支从已检查的本地 HEAD 创建并切换，失败时回报已创建或未知步骤。进程内 requestId 同内容去重、不同内容拒绝；Git 传输使用现有 Git 凭据，不注入平台 token。

GitLab 远端 mutator 同样必须带上述身份/会话确认；评论、review、关闭和合并明确使用 `objectKind:'pull'`。`COMMENT` 发普通 note；`APPROVE` 携带期望 head SHA。已知审批需重新认证或无法确认该策略时不开放 APPROVE，也不收集密码；带正文审批先检查支持，再按 comment → approve 执行。第一步成功后第二步失败返回 partial；第二步发送后结果未知返回 `git/write-result-unknown`，details 标出已成功的 comment id，重复 requestId 不重发。合并只开放项目策略与对象当前 `squash_on_merge` 共同支持的 `merge` 或 `squash`；对象缺少该事实或两者冲突时禁用。Host 写前重新读取并显式发送所选 squash 值、期望 SHA 和 `should_remove_source_branch:false`；项目或分支策略仍可能在核验后变化，没有原子策略前置。回执确认已合并但 squash 结果缺失或不符、或报告源分支将被移除时，返回 partial 并保留已合并事实，要求用户核对而不重试。draft、locked、未知状态或已知阻断不得发送；关闭、创建、评论没有原子 SHA 前置，发送前核对仅为 best-effort。创建请求的 `head` 必须含同实例的 `provider`、`instance`、`path`、已验证 `projectId`，source/target 都须属于本地 origin/upstream，Host 验证两条远端分支存在，不 push 或创建 fork。分支编码只在绑定数字项目与精确分支的 GET 中允许。发送后超时/丢响应/5xx、写成功后会话或实例失效、以及 Client 无法验证写回执的作用域/generation 时，均作为 `git/write-result-unknown` 并要求刷新具体对象；已知未发送、权限拒绝与部分完成单独报告。GitLab inline 写、Issue 写、REQUEST_CHANGES、unapprove、rebase 和自动合并仍拒绝。

Client 主 fiber 提供 GitHub/GitLab 切换、按本地 remote 的实例/仓库选择和逐实例认证修复，浏览 MR/Issue、当前审批、讨论、提交与比较，按对象 facts 启用受支持操作。旧 Host 未宣告 v2 时不发送 GitLab scoped 请求。关闭与合并先展示实例、仓库、对象、head SHA 和账号并要求再次确认；上下文变化使确认失效。部分或未知结果会阻止再次提交，要求刷新具体对象、加载相关分页并由用户确认已核对；本地 Git 的部分回执还要求检查分支和工作树。提交去重和对账状态仅在当前进程有效。GitLab 正文使用安全 Markdown 子集，未知 HTML 以文本展示，链接只允许已验证实例范围，图片显示替代文本而不自动加载，安全折叠可展开；行内写保持禁用。

Remote 加载与平台认证弹窗复用已发现 remote 的 provider；完整交互以[Client 加载反馈](#client-加载反馈current)为准。

GitLab 的 `remote-notifications` 只读取已认证 viewer、已核验项目范围内 pending 且结构化 `action_name:review_requested` 的 MR todo；项目 id/path、target 项目/id/iid、状态与安全网页链接均单独校验。续页复用绑定实例、项目、viewer、generation、查询和会话的不透明游标；不会标记 todo 完成，也不从自然语言或审批快照伪造 changes-requested。Client 按实例、项目、账号、generation、对象与状态/时间去重，仅对已加载的本人 MR 逐个复查状态；本地 push 建议只针对已验证的本地 origin/upstream：显式 push 使用 origin；sync 前后读取的 Git push remote 与分支一致且属于允许集合时才投影可选 `pushedRemote`，无法证明时不猜测。通知停留在所属 GitLab 视图，原生通知是可卸载增强；范围和请求失败均不代表所有账号事件已覆盖。

`remote-retire-grant` 只接受 `{remoteProtocol:2,provider:'gitlab',instance}`；完整规范化后由 Host 推导本插件 key。未登记 scope 可纯存储清理，已登记时拒绝；锁内验证 v2 绑定并用新 revision 替换为无秘密 retired signed-out 标记。回执 `{remoteProtocol:2,scope,generation:null,value:{disposition}}` 的 disposition 为 `retired`、`already-retired` 或 `absent`；不依赖枚举、不发网络、不解析外部 ref、不撤销服务端 token。普通 `remote-clear-grant` 仍删除活动实例的本地 grant 并恢复发现。插件设置页“平台账号”分区在账号卡片下方提供两步清理入口：输入旧实例 URL、展示规范 scope、再次确认后删除。

GitHub scoped 读写通过旧 owner 的显式适配层，写入另须 `expectedInstance:'https://github.com'`，并按 scope、仓库、generation、viewer 和 requestId 隔离去重及内容指纹。v2 仓库/对象 facts 单独提供 operationSupport、支持的方法/事件集；合并方法取仓库的 `allow_merge_commit` / `allow_squash_merge`，缺证据时禁用并在写前复核。Issue 远端写入不支持，动作同时为 false。v2 写回执包含 outcome/steps，checkout 和 issue-branch 可回部分完成。既有 GitHub v1 行为不依赖 v2。

GitHub 详情页在 v1 写入时仍显式传递当前对象的 `number`，Review 与 checkout 同时携带当前 `expectedHeadSha`。GitHub 的 v1/v2 `remote-review` 对 `COMMENT`、`APPROVE`、`REQUEST_CHANGES` 均要求该 SHA；GitLab 仅 `APPROVE` Review 携带 SHA。GitLab 的 `reviewPermissions.APPROVE` 检查只约束 GitLab；GitHub 未返回该可选字段时，审批仍依据动作支持、支持事件集和 `actions.canReview` 判断，再由 Host 校验。

GitHub v2 详情写操作进入对账后，必须由本次定向刷新重新读取对象，并完成评论、行内线程、commits 和 reviews 的全部续页，才开放显式确认；续页失败或被更新的刷新取代时继续锁定，旧响应不能解除门禁。普通浏览的续页完成不算写操作对账，也不会自动确认或重试写入。

## 配置与认证

`src/remote/settings.ts` 是配置解析/验证真源，schema 位于 `src/index.ts`。字段均为可选 volatile：

| 字段 | 默认 | 语义 |
| --- | --- | --- |
| `clientId` | 发行默认或无 | GitHub Device Flow 公共 client_id；显式配置覆盖发行默认，显式空字符串禁用默认；无有效值时 OAuth 禁用并提示配置，发现链仍可用 |
| `instances` | 内建 GitLab.com | 最多 16 条显式 GitLab 实例配置；`url`、`label?`、`clientId?`、`credentialRef?`、`sshHost?`、`sshPort?`，身份规则见[多实例设计 D2](../architecture/remote-platform-instances.md#d2-配置与实例身份gl-r2gl-r9gl-r13) |
| `requestTimeoutMs` | `15000` | HTTP 请求总超时，含全部重定向和正文读取 |
| `probeTimeoutMs` | `5000` | 非交互凭据探针超时，范围 1–5000 ms |
| `refreshTtlMs` | `30000` | 刷新持久意图及旁观等待 TTL |
| `refreshPollMs` | `250` | 旁观间隔，正值且不大于 TTL |
| `refreshStoreExclusive` | `false` | 部署方对 store 跨进程 `modifyRecord` 互斥的正向保证；缺少时不自动旋转 |
| `maxResponseBytes` | `4194304` | 单响应正文上限，流式读取超限立即取消 |

发行应用 ID 的唯一登记位置是仓库根 [`oauth-apps.json`](../../oauth-apps.json)，当前包含维护者提供的 GitHub.com OAuth App 与 GitLab.com public OAuth Application 的公开 ID。普通 `pnpm build` / `pnpm bundle` 自动将其嵌入 Host 产物，Client 仍只通过 RPC 发起登录，不内置秘密。发行方可用构建环境变量 `DSH_GIT_GITHUB_CLIENT_ID` / `DSH_GIT_GITLAB_CLIENT_ID` 覆盖登记值，显式空环境变量禁用对应构建默认。运行时显式 `remote.clientId` / GitLab.com 实例 `clientId` 优先于产物内置值，显式空字符串禁用默认；自建实例不继承 GitLab.com 的 App。未注入构建默认的源码/测试模块仍需显式应用配置；不增加运行时环境读取或 client secret。有效 App 改变后继续执行已有 grant 绑定/失效规则。登记和打包成功不等于真实设备授权或账号登录已验收。

登录结果保留 `expiresAt` / `intervalMs`；GitLab 可追加可选 `verificationUriComplete`。Client 兼容旧结果缺少这些字段，缺有效期时不显示倒计时；公开结果不含 `device_code` 或 token。

GrantRecord v1 的键为 `dsh-plugin-git/github-com`；迁移通过 `modifyRecord` CAS，提交使用新的 revision。发现链为 authenticated grant → `GH_TOKEN`/`GITHUB_TOKEN` ref → `gh auth token` → 匿名，ref source 以 provider 为准。ref 每操作重解析；gh 只在身份建立/事件/显式重试中运行，不能随 REST 分页反复启动。401 把该 token 标为 invalid，不自动换账号；曾有凭据后丢失不会静默变成匿名。`git credential fill` 仅用户显式触发，固定 hostname 经 stdin 输入，输出不进入 RPC、日志或 argv；所有探针非交互、≤5s、有界收集并等待退出。

`authSelection?:{method:'auto'|'cli'|'oauth',cliAvailable:boolean,oauthCached:boolean}` 是新增的可选协商字段，只报告已知内存事实，不因 capability 轮询读取秘密、发网络或启动 CLI。首次建立身份时读取持久偏好；未存偏好为 `auto`，保留上述发现链。选择方式单独存于 `dsh-plugin-git-auth/<原 grant 的 host-id>`，使用标准 credentials 的 `kind:'grant'` 元数据记录，payload 为 `{v:1,provider,instance,method,revision}`；不含 token。按实例隔离，未知字段或绑定错误拒绝使用，不静默换账号。CLI 方式只使用 gh/glab 自己管理的凭据，不复制到 OAuth grant；只有 GitLab.com 支持现有 glab 发现入口。

切到 CLI 仅保存偏好并建立 CLI 身份，保留原 OAuth grant；切回 OAuth 优先复用该实例绑定的 grant，仍执行到期、App 绑定、401 与现有刷新互斥/CAS 检查，确需重新授权才启动 Device Flow。方式与 grant 均由 credentials 持久化，Host 重建后恢复；过期、已撤销或客户端配置不匹配的授权不会因为“缓存”被视为有效。`oauthCached` 只表示已知本地记录可清理，不保证 token 有效。“退出 OAuth”取消本地登录 attempt，删除 access/refresh token 并持久写入无秘密的 signed-out 标记；不调用 gh/glab logout，不删除 CLI 凭据，不撤销服务端 token。若当前显式选择 CLI，则保持 CLI 身份；否则停止 OAuth 身份与隐式发现，用户可显式选择 CLI 或重新登录 OAuth。旧 `remote-sign-out` / `remote-clear-grant` 仍保留全局抑制/恢复发现语义并重置偏好为 auto。

| 认证端点 | payload / 结果 |
| --- | --- |
| `remote-login` | `{}` → `{attemptId,userCode,verificationUri,expiresAt,intervalMs}`；只发射用户码，不发射 device_code/token |
| `remote-poll-login` | `{attemptId}` → `{state:'authenticated'}`；共享同 attempt 的轮询，累计 slow_down，取消/拒绝/过期不提交授权 |
| `remote-cancel-login` | `{attemptId}`；取消轮询并 CAS 结束该 attempt |
| `remote-select-auth` | `{method:'cli'|'oauth'}` → capability；持久选择方式，保留 OAuth grant |
| `remote-oauth-logout` | `{}` → capability；仅清除 OAuth 秘密并保留退出标记 |
| `remote-sign-out` | `{}`；持久 signed-out 抑制全部发现 |
| `remote-clear-grant` | `{}`；仅删除本地 grant，恢复发现，不撤销 GitHub 服务端 token |
| `remote-retry-auth` | `{}`；显式重建身份，返回 capability |
| `remote-use-git-credential` | `{}`；显式非交互 helper 探测，返回 capability |

Device Flow 只允许 `https://github.com/login/device`。刷新先 CAS 提交 refreshing marker，再在锁外交换，最后核对 refreshId/basedOnRevision 提交新 token。prepare 失败不发送；仅传输确认未发送时可恢复旧快照；超时、取消、5xx、丢失响应或崩溃一律不重放，由 reauth-required 收敛。complete 失败丢弃新 token 并报告 `{stage:'complete',remoteUpdated:true,localCommitted:false}`。

## 仓库与读取

`remote-repositories` 接收 `{repository,sessionId?}`，返回 `{state:'supported'|'no-remotes'|'unsupported',remotes:[{name,identity}]}`。仅 origin/upstream 中受支持的 GitHub HTTPS/SSH URL 进入允许集合；带 URL 凭据或其他 host 不准入。

其余仓库端点都带 `{repository,sessionId?,host:'github.com',owner,repo}`，Host 核对目标属于该本地允许集合。读取返回 `{generation,value}`，列表 value 为 `{items,truncated,next?}`：`truncated` 表示上游在已取页之外还有更多内容，`next` 为不透明续页游标（上游 `Link rel="next"`，经 API origin 校验、不含 token）。列表端点额外接受 `{cursor?,pages?}`：`cursor` 从游标处继续（Provider 重新校验 origin，越界 origin 拒绝），`pages` 为本次请求最多读取的上游页数（默认 1，钳制在分页上限内）。每页 ≤100 条、单请求页数有上限（通知每页 50），列表无总条数天花板——Client 以游标渐进流式续取直至取尽；响应缓存最多 128 项。

| 端点 | 附加字段 / value |
| --- | --- |
| `remote-repository` | viewer、原始已知权限位、五项动作三态；存储可写不能推导远端权限 |
| `remote-list-prs` / `remote-list-issues` | `state?:open|closed|all, cursor?, pages?`；Issue 列表排除 PR |
| `remote-pr` / `remote-issue` | `number`；PR 显式保存 head/base 仓库、ref、SHA；state 为 open/closed/merged，保留 rawState；`createdAt` 保留上游 `created_at` |
| `remote-comments` | `number,inline?:boolean, cursor?, pages?`；inline 保存 replyTo、commitSha、原始行/side 与 `reviewId`（归属的 review id，供按 review 分组展示），outdated 不冒充当前坐标；`createdAt` 保留上游 `created_at` |
| `remote-commits` | `number, cursor?, pages?`；返回 `{items,truncated,next?}`，commit 为 `{sha,subject,author,date?,committedAt?,url?}`，`committedAt` 取自 `commit.committer.date` |
| `remote-reviews` | `number, cursor?, pages?`；返回 `{items,truncated,next?}`，review 为 `{id,author,state,rawState,body,url?,submittedAt?,commitSha?}`，`state` 归一为 `approved|changes-requested|commented|dismissed|pending` |
| `remote-files` | `number, cursor?, pages?, expectedBaseSha?, expectedHeadSha?`；返回 `{files:{items,truncated,next?},baseSha,headSha}`；首页读取前后核对 PR 快照，续页携带 expected SHA 并逐页核对 head/base 未动。PR 详情页不主动调用：文件改动经 `pr.url + '/files'` 跳转 GitHub Files 页查看，该能力保留给需要本地坐标的受守护写路径 |
| `remote-notifications` | `automatic?:boolean`；review request、自己 PR merged/closed/changes-requested，稳定事件 id；最多展开 10 个通知线程，超限标 truncated |

API token 仅发往 `https://api.github.com`，带 `X-GitHub-Api-Version:2022-11-28`；Link 与 GET 重定向也校验该 origin。浏览器 URL 独立只允许 `https://github.com`；头像 URL（viewer 与各 `author.avatarUrl`）进一步只允许 `https://avatars.githubusercontent.com` 且不带凭据，其余来源一律省略。响应显式投影成中立模型，不透传 raw 对象。成功的 `GET /user` 结果在同一 generation 内复用；查询失败即清除 viewer Promise 缓存，让后续操作重新查询，仍遵守认证状态与限流门禁。认证 ETag 正文按 origin/viewer/generation/完整路径与查询隔离；身份变化清空。匿名不自动轮询，认证轮询最短 60 秒且遵守更长的 X-Poll-Interval；429、primary/secondary 403 遵守 Retry-After/reset 与有界指数退避，不自动重试写请求。

### Client 加载反馈（Current）

远端正文的 HTML 子集由 `github-markdown.ts` 归一为 Markdown 与折叠块；数字实体仅在 `0..0x10FFFF` 范围内转换，越界实体保留原文，避免畸形 PR/Issue 正文或评论中断详情渲染。

Remote 列表、详情与认证弹窗通过顶部状态条区分查找远端、连接已识别平台、读取列表/讨论、认证连接、等待用户授权及提交操作。网络等待超过 8 秒显示慢响应提示；等待 Device Flow 用户授权不标为慢网。首次列表加载使用骨架占位，不提前显示“没有远端”或筛选结果为空。列表及详情关联集合首批仅请求一页，其余由现有游标机制后台补齐，并显示补页状态。刷新或切换筛选时保留已有条目及其原始 PR/Issue 类型，可继续打开详情；写入仍受 busy/unknown 门禁保护。请求失败后移除加载反馈、以 toast 提示简短本地化摘要并隐藏原始错误码，原始码与已放行的 details 字段只能通过 toast 的复制详情操作查看，同时恢复显式刷新入口；内容面板不再渲染红色错误文案，首载失败处仅显示同色第三级提示。剪贴板 API 缺失、同步异常和异步写入失败均显示本地化复制失败反馈；受阻写入的常驻提示在复制后保留核对确认入口及再次复制操作。所有文案提供中英文，动画遵守 reduced-motion 偏好。

认证弹窗以“{平台} 账号”为标题，主体是身份卡（头像、`@login`、连接状态或登录反馈）加“连接方式”两张说明卡（CLI 与 OAuth 各自一条可用性/说明文案），GitLab 弹窗底部另附 GitLab-only 说明（登录仅用于 GitLab 内容、通知覆盖范围），GitHub 弹窗不显示这些说明。标题、来源与授权提示随平台变化，未知来源省略来源标签。选中态只由 capability 派生，CLI 已认证不隐藏 OAuth；`loginAvailable`、存储可写和 Device Flow support 共同决定 OAuth 是否启用，缺 App、只读或已知不支持时保留禁用选项并解释原因，unknown 时提示可显式尝试。支持 `authSelection` 的 Host 使用 `remote-select-auth` 切换、展示已保存 OAuth 提示，并仅对本地 OAuth 授权提供“退出 OAuth”；没有该字段的旧 Host 保留原认证端点兼容路径（切 CLI 时可能清除旧 grant）。设备码登录卡片在 OAuth 选项下方就地展开；孤儿 GitLab 授权清理已移至插件设置页“平台账号”分区，仍要求规范 URL 的独立二次确认。

用户选择 OAuth 后，Host 自动获取设备码；控制器保留当前 attempt，调用现有轮询，每个 attempt 只自动打开浏览器一次。GitLab 优先使用 Host/Client 双重校验的 `verificationUriComplete`（origin、部署前缀、精确路径、唯一且匹配用户码的 query）；旧 Host 没有该字段时回退普通链接。GitHub 只使用官方普通验证页，用户可点击“复制设备码”后粘贴确认。复制失败不得显示成功；打开失败、没有 Desktop 或增强卸载时，保留手工外链与可复制的码。`shell.openExternal` 和 `clipboard.writeText` 仅通过可卸载 Desktop 子 fiber 的结构回调提供；HTTP/轮询留在 Host，浏览器在当前 Client 设备打开，支持远程 Host。

GitLab 的限流/退避与服务端轮询间隔按实例内的凭据摘要隔离，读、审批策略及写入共用该凭据的预算。CLI/OAuth 切换不能把旧凭据的 `blockedUntil` 带给另一凭据；切回原凭据或仅重建认证 generation 仍保留其原有限流期限。预算仅在 Host 实例生命周期中保留，Map 键为摘要、不保存原始 token，也不通过 RPC 返回；响应/分页/游标缓存仍按既有 generation 规则隔离。切换后新凭据若也收到服务端限流，仍遵守它自己的 Retry-After/reset 与退避，写请求不会自动重放。

GitLab 读取遇到 `git/signed-out` 或 `git/unauthenticated` 时仍撤回仓库、viewer 与动作事实，并取消旧请求；随后通过新请求通道读取同一实例的认证 capability，以恢复认证入口。已确认的 signed-out 显示为正常退出状态，不把原始错误码持续留在页面；已知退出时不继续读取受保护的仓库/列表。能力读取暂时失败后，打开弹窗或显式认证可重试该实例的 capability，不能用全局 GitHub capability 决定 GitLab 登录入口。整个恢复过程不清除退出标记、不自动登录；只有用户显式选择 CLI/OAuth 才继续认证。

等待期间禁切认证方法，显示服务端有效期倒计时；不将打开浏览器视为授权成功，收到授权后重新核验账号并刷新对应实例数据。取消、过期、拒绝与网络失败给本地化结果并允许用户重试；不自动创建下一轮登录。关弹窗不取消，重开恢复同一 attempt；实例/工作区/账号变更、卸载或显式取消会丢弃旧结果并清理所属 attempt，迟到响应不能污染新账号。认证完成后立即刷新 capability；旧读取在途时追加一次读取。token、fingerprint、`device_code` 不进入 UI；展示/复制的是 `userCode`。隔离测试边界见[浏览器 E2E](../development/browser-e2e.md)。

### Client 缓存与增量校验（Current）

`GitRemoteFeature` 按会话和视图持有控制器（列表与各 PR/Issue 详情独立），tab 卸载不再销毁状态或中断在途分页；卸载整个 feature 才统一取消。缓存仅存在当前 Client 内存，不写磁盘，重启后重新加载。最多保留 64 个控制器槽位，新增视图时按最近使用顺序淘汰空闲项；已挂载、在途分页/重试及写入结果未知的控制器不参与淘汰，因此被保护项较多时可临时超过 64。每个控制器另保留最多 12 组按远端身份、PR/Issue 类型和 open/closed/all 筛选隔离的列表快照；同工作区回到页签时恢复已选筛选、已取分页与详情。

切回视图或筛选时，60 秒内的数据直接复用；过期则在保留原内容的同时校验。切换到其他远端身份时，先清空旧目标的条目、详情集合和游标；新目标加载失败或分页未完成时也不展示旧目标内容，返回原目标仍可恢复其独立缓存。显式刷新和详情 `navigation.revision` 变化绕过对应的新鲜度门禁。静态 capability 的 5 秒轮询本身不触发列表重新校验，也不引入匿名自动网络轮询。同一目标校验失败保留旧内容与错误，避免渲染触发重试循环，仍可显式刷新。

刷新仍从首页起逐页校验，复用 Host 已有的 ETag / `If-None-Match`：未变化页以 304 复用正文，仅变化页重新传输正文；这是分页级条件更新，并非依赖上游变更游标的逐条增量同步。Client 按稳定 id 合并并保留未变化行的对象引用；刷新期间保留尚未校验的旧尾页，最后一页完成后移除本轮已不存在的记录，覆盖关闭、删除及排序/分页位置变化。

仓库重绑定、功能 off、登录身份/generation 变化会清空视图和筛选缓存并取消旧请求；远端写入（含失败或未知结果）使同本地仓库的其他缓存过期。未知写结果门禁不会因切 tab、缓存命中或自动校验而解除，仍须显式定向刷新；不自动重放写请求。

Device Flow 授权等待或后台分页进行期间暂停控制器的通知轮询，避免同一 scoped 通道的新请求作废在途登录或续页响应；分页结束后的下一次轮询可正常执行，授权成功后刷新认证与列表。GitLab 操作在途时切换方式或退出 OAuth，会取消旧操作并保留原目标作用域用于认证请求；旧操作的迟到响应不能覆盖新状态。

## 受保护写操作

所有仓库 mutator 逐项进入 `isRepositoryWrite`。payload 在仓库字段之外，必须有 `{expectedGeneration,expectedViewer:{host,userId},requestId}`。requestId 为 8–200 位字母/数字/连字符，同一进程重复提交只返回第一次的结果，包括未知结果；最多保留 512 个提交，满后拒绝，不能用淘汰重放副作用。Host 在准入和发送前核对会话仓库、远端身份、stable viewer 与单份 token 快照；最后解析只用来比较，发送仍用被核对的原 token。

| 端点 | 附加字段 |
| --- | --- |
| `remote-comment` | `number,body`（PR 级评论） |
| `remote-inline-comment` | `number,body,expectedHeadSha,path,line,side,startLine?,startSide?` |
| `remote-review` | `number,body,expectedHeadSha,event:APPROVE|COMMENT|REQUEST_CHANGES` |
| `remote-create-pr` | `title,body,head:{host,owner,repo},headRef,baseRef,draft?`；检查已推送的 head/base 分支，不 push/fork |
| `remote-close-pr` | `number,expectedHeadSha`；Client 两步确认 |
| `remote-merge-pr` | `number,expectedHeadSha,method?:merge|squash|rebase`；Client 两步确认，映射到 GitHub sha 前置条件 |
| `remote-checkout-pr` | `number,expectedHeadSha,branch?`；可指定无冲突分支名 |
| `remote-issue-branch` | `number`；复用 create/switch 创建 `issue-N-slug` |

行内坐标由 `src/remote/diff.ts` 从原始 hunk 解析并在 Host 校验：必须属于同文件、commit、side、hunk；多行范围还须有序。提交用 line/side、start_line/start_side、commit_id，不用 deprecated position。当前便携 UI 不渲染本地 diff、没有锚点选择器，因此不暴露 `remote-inline-comment` 入口；行内 review 评论只读展示并按 `reviewId` 嵌套在对应 review 下。

checkout 抓取到含 base repo hash 的私有 ref，核验 API head SHA；同仓库 tracking 用 expected-old CAS（不存在用零 SHA），已领先则 head-moved、分叉拒绝，缺映射仅追加。分支从核验 SHA 创建/复用，核对已有 upstream；不覆盖用户分支，不强制切换其他 worktree。回执包含 switched、privateRefWritten、trackingRefPrepared、fetchMappingAdded、upstreamNotConfigured、branch、实际 head（可得时）与 error。false 表示该阶段未确认完成，不承诺跨 ref/config 原子回滚；出错不自动删除准备结果。Git 传输使用用户既有 Git 凭据，不桥接平台 OAuth。

发送后响应丢失、超时、取消、5xx 返回 `git/write-result-unknown`；Client 保留待确认提示并禁用后续写，须显式定向刷新目标后检查，不自动重发。成功回复只投影 id/number/url/merged。权限/scope/SSO 拒绝与 head-moved 要求修复或重新确认。

## 错误与验证边界

错误码为 `git/remote-unavailable`、`git/unauthenticated`、`git/signed-out`、`git/insufficient-scope`、`git/head-moved`、`git/rate-limited`（resetAt）、`git/write-result-unknown`、`git/remote-identity-mismatch`。无 seam 时其余已知/未知 remote 端点均在解析 payload 前 fail-closed。

自动化证据分布在 `tests/remote-*.spec.ts` 与 `tests/remote-surface.client.spec.tsx`。真实 OAuth/SSO、远端写入、平台手工验收和完整 release 矩阵的执行状态以[计划日志](../plans/active/remote-platform-integration.md#进度与验证日志)为准；mock 与开发 pin 通过不能代替这些验收。

GitLab 详情中的认证切换、重试与 OAuth 授权完成后，在新身份下重新读取原 MR/Issue 及对象权限，保留详情导航目标；退出时撤回旧身份数据。

v2 scoped 写入与旧通道一致：无论成功、拒绝或响应丢失，均使同一本地仓库下所有会话、列表筛选和详情缓存失效；保留未知结果的定向核对门禁。

运行中的 GitHub Host 发现共享凭据存储的认证偏好 revision 变化时，撤回旧身份，并在下一次 snapshot 内重新建立所选 CLI 身份；无候选也只探测一轮，普通读取不重复启动 CLI。
