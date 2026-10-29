中文 | [English](remote-platform-instances.en.md)

# Design: GitLab 多实例与 Remote 协议演进

- **Status**: Target（GL0设计基线已冻结，非已实现契约）
- **Date**: 2026-10-27
- **范围**：GitLab.com + Self-Managed；GL1–GL4 已通过自动阶段验证。本文字段、限制、示例和测试仍是冻结的完整目标；已落地行为以[RPC reference](../reference/remote-platform-rpc.md)为准，阶段与未执行验收见计划。

## 背景

[active plan](../plans/active/remote-platform-integration.md)维护 GL-R0–R13 的评审处置、冻结清单与阶段进度；本文维护具体结构、配置、协议示例与验收用例，二者不复制状态。沿用 [ADR-0004](../decisions/ADR-0004-remote-platform-integration.md) 的门禁、凭据安全与可移植性约束。用户已复核通过 B1 修订，长期取舍记录于 [ADR-0005](../decisions/ADR-0005-remote-provider-instances.md)（Accepted）；GL0设计冻结记录见计划；冻结当时不自动接受ADR-0004或授权实施，GL1 后续授权也记录在计划。

## GL0 冻结时的历史起点

- [runtime](../../src/remote/runtime.ts)直接构造 GitHubProvider；仓库模型、grant key、HTTP origin 与 remote 解析均有 GitHub 专用约束。
- [已发布 RPC 参考](../reference/remote-platform-rpc.md)是当前契约；[Host 分发](../../src/index.ts)忽略 remote-capability 的 payload，不能仅靠发送新参数证明旧 Host 已处理实例作用域。
- [导出类型](../../src/types.ts)包括 RemoteProvider/RemoteRepository 等；[现有 Client](../../src/client/remote/RemotePullActions.tsx)仅通过 action === false 禁用按钮；[generation](../../src/remote/auth.ts)使用运行时随机 instanceId。旧字段改义、扩大已导出 union 或新字符串动作状态均需要兼容审查。

## 冻结目标（Target）

### D1 组件与生命周期（GL-R0、GL-R10）

采用 interface + 组合：业务编排依赖新的内部 ScopedRemoteProvider；工厂在装配边界注入 GitHub/GitLab 适配器、AuthDescriptor、HttpPolicy 与独立 InstanceContext。旧导出 RemoteProvider/RemoteRepository 保留为 GitHub v1 视图，通过适配器投影；新增 ScopedRemote* 类型，不把旧类型原地改成要求调用者处理 GitLab 的 union。

每个 context 拥有 auth、运行时 generation、viewer/权限/ETag、请求集合、登录 attempt、通知去重与提交去重。注册表 key 为规范 instance URL；最多 16 个显式 GitLab 实例配置，拒绝重复规范 URL，不静默覆盖。列表变化先完整验证，再仅重建变更/移除的 context；重建停止准入、取消并 drain、作废游标和写确认；相同实例新上下文产生新随机 generation.instanceId。账户变化按 ADR 递增 revision；两个实例相同 userId 仍完全隔离。

注册表锁内只发布配置快照、移除旧 owner 并同步触发取消，不等待请求 drain。旧业务请求的仓库守护可重入 list/guard 并有界结束；同实例 replacement 在锁外等待旧 owner drain 后，重新锁定并复核配置再创建。卸载关闭准入后，在锁外等待当前与已移除 owner 的全部 drain，不能把 drain Promise 接到准入串行链上。Client 切换目标或作废身份时同步清除登录设备码/链接，取消请求使用原实例 scope 与独立清理通道，旧轮询回复按 epoch 丢弃；同实例切换也不能由清理请求作废新读取或新登录。

credentials seam 仍为整功能硬门禁；单个实例配置/认证/网络失败只影响其自身，不关闭其他实例或本地 UI。所有 portable UI 属于主 fiber；Desktop 子 fiber 仅承载可卸载通知增强。

### D2 配置与实例身份（GL-R2、GL-R9、GL-R13）

目标配置：

```json
{
  "remote": {
    "clientId": "existing-github-app",
    "instances": [
      {"url": "https://gitlab.com", "clientId": "gitlab-com-app"},
      {"url": "https://git.example.com", "clientId": "self-managed-default-app"},
      {"url": "https://git.example.com:8443/gitlab", "sshHost": "git.internal.example", "sshPort": 2222, "clientId": "self-managed-app", "credentialRef": "DSH_GITLAB_OFFICE"}
    ]
  }
}
```

remote.clientId 继续只表示 GitHub；instances[] 只登记 GitLab，不消费旧 clientId。GitLab.com 的 remote 识别与匿名默认描述内建，同 URL 的单条配置补充 App 等覆盖值而不新建第二个 context；未登记的自建 remote 不触发网络发现。取消可编辑 id 字段，新增可选 label 仅展示；url 为安全身份。clientId/credentialRef 可选，credentialRef 仅为符合现有 ref 语法的引用名，设置中不得出现 token/secret。sshHost 缺省为 URL hostname、sshPort 缺省 22；用户改写仅影响显式 SSH 映射，不改变 API 身份。相同 SSH 映射和仓库路径归属有歧义时拒绝。

规范化算法：先对原始输入校验，再构造 URL，禁止解析器先吞掉 dot segments。仅 HTTPS；拒绝 userinfo、query、fragment、反斜杠、重复路径分隔、`.`/`..`（含编码形式）、编码斜杠及嵌套编码；域名经 URL/IDNA 转小写、IP 使用 URL 标准序列化（IPv6 保留方括号），443 省略、其他端口保留。前缀逐段以 ASCII URL-unreserved 字符表达并保留大小写；暂不支持需百分号编码的部署前缀，项目 namespace 编码由仓库模型单独处理。根路径和末尾斜杠统一移除；规范 URL UTF-8 最多 512 bytes，超出拒绝，不截断。

实例 URL 的 UTF-8 bytes 取无填充小写 RFC 4648 base32，加 `gl-` 作为 credential host-id；GitLab.com 特例为 gitlab-com，GitHub 仍为 github-com。最长 host-id 823 字符，含 dsh-plugin-git/ 的 record key 最长 838 字符；实际 backing store 的有界实证及限制见[计划 B2](../plans/active/remote-platform-integration.md#b2b4-证据与最终冻结复核2026-10-27)，不由编码算法本身推出存储兼容。

| 输入 / 规范实例 | 预期结果（设计 fixture） |
| --- | --- |
| `https://GIT.EXAMPLE.COM:443/` | `https://git.example.com`；host-id `gl-nb2hi4dthixs6z3joqxgk6dbnvygyzjomnxw2` |
| `https://git.example.com:8443/gitlab/` | 规范 URL 无末斜杠；host-id `gl-nb2hi4dthixs6z3joqxgk6dbnvygyzjomnxw2orygq2dgl3hnf2gyylc` |
| 同域 `:8443/GitLab` | 与小写 gitlab 前缀不同实例，不共享 grant |
| `http://host`、含 `%2f`/`%252f`、userinfo 或 `a/../b` | 拒绝；不得发任何网络请求 |


#### G1 已移除实例的授权清理（B1复核通过，GL0已冻结）

新增仅 v2 可调用的 `remote-retire-grant`，与正常 `remote-clear-grant` 的删除/恢复发现语义分开。请求为 `{remoteProtocol:2,provider:'gitlab',instance}`；Host 先验证原始输入，再按 D2 完整规范化后推导 key，不要求输入字面量已是规范形式。例如 https://GIT.EXAMPLE.COM/ 与 https://git.example.com 指向同一 key，回执 scope 使用规范 URL；Client 按相同规范化后比较 scope，不拿原始输入字面量与回执比较。危险格式仍拒绝。**仅此操作**允许 scope 未登记/已删除。Host 自行推导本插件固定命名空间的 key，不接收任意 key/ref/clientId，也不借此信任该 URL 作网络目标。其他未登记 scope 的登录、登出、清除和仓库端点仍按 D3 拒绝。

该操作在完整 credentials seam 下仅通过 `modifyRecord` 读取并处理该 key：无记录时不写，返回 absent；合法 GitLab v2 grant 且 provider/instance 与推导 key 匹配时，以新 revision 写入 `{v:2,state:'signed-out',provider:'gitlab',instance,revision,retired:true}`，完全移除 access/refresh token、登录/刷新意图与旧 App 字段；已为合法 retired 标记时返回 already-retired。未知、畸形、GitHub v1 或绑定不符的记录拒绝覆盖，返回脱敏 record-mismatch。采用锁内当前记录进行判断；旧刷新 complete 的 CAS 无法匹配被替换的 revision。已锁定 seam 的 `modifyRecord` 返回 undefined 表示不修改，**不是删除**；此方案不假定条件 deleteRecord，也不发明持久 tombstone 索引。

清理不创建 context/generation，不发事件探针/子进程/HTTP，不写实例配置，不改其他实例或外部 ref，亦不撤销服务端 token。成功按 D3 回 `{remoteProtocol:2,scope,generation:null,value:{disposition:'retired'|'already-retired'|'absent'}}`。UI 对旧 URL 提供显式确认的“清除旧实例本地授权（保留退出标记）”；只向用户展示该 scope 与脱敏结果，不要求先重新登记或联网。重启后仍可用同一旧 URL 调用；无需枚举凭据记录或保存机器外部 URL 历史。retired 标记保留以防重新登记后静默自动发现；重新登记后由正常清除/登录恢复使用，旧 signed-out 读法识别该无 App 标记。

若清理时该 URL 已重新登记，返回 instance-registered，要求走活动实例的正常认证操作，不在后台作清理。注册表配置操作与此检查/存储调用在本 Host 串行；其他 Host 显式发起的新登录仍受原有 CAS/状态机约束，清理不承诺阻止未来显式授权。存储提交失败返回可修复错误，不宣称秘密已清除。`generation:null` 回执仅属于清理 UI，不得用于仓库写确认；清理响应按 scope+本次请求序号处理，不清空当前其他实例的状态。

本路径不依赖记录枚举；listRecords 不属于当前锁定 seam 的探测清单。未来如需孤儿记录列表，应单独评审能力与兼容面扩展。

### D3 协商与兼容（GL-R0、GL-R3、GL-R10、GL-R12）

选择显式 remoteProtocol=2 的作用域通道，沿用现有端点名。新 Client 首先发送旧 remote-capability {}；新 Host 在原 GitHub 应答旁增加 remoteProtocol:2，旧字段/含义不变。Client 只有看到该宣告，才能调用 scoped 端点，且每个 scoped 应答须回显相同协议与 scope。不存在回显、与目标不符或 Host 不支持时，GitLab 操作 fail-closed，绝不能回退为无作用域 GitHub 写入。

```json
{"endpoint":"remote-capability","payload":{}}
{"state":"on","generation":{"instanceId":"opaque-runtime-id","revision":0},"credential":{"configured":false,"writable":true},"auth":{"state":"unauthenticated"},"actions":{"canComment":"unknown","canReview":"unknown","canMerge":"unknown","canClose":"unknown","canCreatePr":"unknown"},"loginAvailable":true,"automaticRefreshAvailable":false,"remoteProtocol":2}
```

以下为 scoped payload 与两类应答；示例中的 value 表示对应端点数据，scope 必须由 Host 校验并返回：

```json
{"remoteProtocol":2,"provider":"gitlab","instance":"https://git.example.com:8443/gitlab"}
{"remoteProtocol":2,"scope":{"provider":"gitlab","instance":"https://git.example.com:8443/gitlab"},"generation":{"instanceId":"other-runtime-id","revision":0},"value":{"state":"on","generation":{"instanceId":"other-runtime-id","revision":0},"credential":{"configured":false,"writable":true},"auth":{"state":"unauthenticated"},"authMethods":{"deviceFlow":{"supported":"unknown","reason":"not-verified"}},"actions":{"canComment":false,"canReview":false,"canMerge":false,"canClose":false,"canCreatePr":false},"loginAvailable":true,"automaticRefreshAvailable":false}}
{"remoteProtocol":2,"scope":{"provider":"gitlab","instance":"https://git.example.com:8443/gitlab"},"generation":{"instanceId":"other-runtime-id","revision":1},"value":{"items":[],"truncated":false}}
```

无 marker 的 capability 调用继续按当前“忽略 payload”的旧约定处理；新 Client 不从中推断实例能力。除 D2 G1 狭义授权清理外，remoteProtocol=2 的未知/不匹配 provider、未登记/已删除实例与缺字段请求返回既有 git/remote-unavailable + 脱敏 reason，不作为 seam off。seam 缺失仍返回旧 off 形态且不建 context；新 Client 必须先处理该全局 off。出现 remoteProtocol 但值不是2时拒绝，不按v1处理。所有 v2 认证端点（包括 poll/cancel）、capability、读取和写操作都携带 scope；attemptId 仅在其 scope 内有效。所有 scoped 成功应答（capability、认证含无返回值操作、读取、写入）统一为 `{remoteProtocol,scope,generation,value}`。活动 context 的 generation 取该操作的凭据快照，认证变更操作回变更后的 generation，不能在发送应答时换成另一个更新快照。Client 一律从顶层 generation 做过期判断；为兼容原 capability 形态保留的 value.generation 必须与顶层相同，否则拒绝。无返回值操作使用 value:null。只有 D2 G1 清理回 generation:null，不创建 context，不能用于写确认；跨实例发现按下述无 scope 专用形态处理。seam off 与既有 RPC 错误属于控制失败而非 scoped 数据，按发起请求的 scope/序号处理，不从错误 details 接纳 generation。

| 组合 | 预期行为 |
| --- | --- |
| 旧 Client / 新 Host | 无作用域仅见原 GitHub 仓库、响应、错误和三态；不接收 GitLab 数据 |
| 新 Client / 旧 Host | GitHub 保持旧通道；未宣告 v2 则 GitLab 入口说明 Host 不支持，不发送 GitLab auth/mutator |
| 新 Client / 新 Host | 协商 v2 后发现/选择实例；逐应答核对 scope + generation，跨实例乱序结果丢弃 |
| seam 缺失 / 任意 Client | 旧 off 保持，GitHub/GitLab remote 全关闭，本地 Git 正常 |

v2 remote-repositories 输入也带 remoteProtocol:2 与原 repository/sessionId；其响应为 `{remoteProtocol:2,value:{state,remotes,unresolved?}}`，允许跨实例发现，因此不声称一个单独 scope。state 保留 supported/no-remotes/unsupported；每个 remotes.identity 显式携带 scope。unresolved 只包含 origin/upstream 名与登记修复 reason，不透传可能含凭据的 URL、不猜陌生域名品牌。混合 provider remote 只允许分别选择，不聚合或跨 provider 创建/checkout 对象。

### D4 仓库、viewer 与凭据模型（GL-R2、GL-R3、GL-R11）

v2 GitLab target 为 `{provider:'gitlab',instance,path,projectId?}`；path 保留完整 namespace。先按本地 origin/upstream 与已登记映射建立允许集合，再从 API 解析 projectId；后续用实例+数字 id 调用，但每次写仍核对最新本地 remote/path 对应此 id，不能由 Client 任意 projectId 越权。改名/迁移只有重新验证配置 remote 与 API 身份后才采用，不因稳定 id 自动扩大允许集合。

GitHub v1 host/owner/repo、viewer.host、expectedViewer.host 和 grant v1 均不改义。v2 新 expectedInstance 等于规范 URL，expectedViewer 仍为 `{host:URL.hostname,userId}`；端口/前缀由 expectedInstance 与已绑定 scope 区分。generation.instanceId 继续是不可解释的运行时随机值，不是 URL。写操作缺少 expectedInstance 或与 scope 不符即拒绝。

```json
{"remoteProtocol":2,"provider":"gitlab","instance":"https://git.example.com:8443/gitlab","repository":"<session-repository>","path":"group/sub/project","projectId":"42","number":7,"body":"Review feedback","expectedInstance":"https://git.example.com:8443/gitlab","expectedViewer":{"host":"git.example.com","userId":"9"},"expectedGeneration":{"instanceId":"opaque-runtime-id","revision":3},"requestId":"example-request-0001"}
```

本轮每实例单账号，追加实例绑定而非复用全局账号。GitLab grant 新增 v2 payload，保留 ADR 的状态/revision/attempt/refresh marker，并以 provider、instance、clientId 绑定；不搬运或覆盖 GitHub v1。authorizing/authenticated OAuth 状态必须匹配 clientId；未配置 App 时 signed-out 抑制记录可不带 clientId，但仍绑定 provider/instance。refs 发现的 token 保持外部来源，不伪装写成 OAuth grant。读取 v2 时遇到未知/畸形/实例或 App 不符即 invalid，不回退发现。选择改 URL 为删除旧 context + 新建，旧 grant 留在原 key，不自动迁移 token；即使 scope 已移除，仍可按 D2 G1 的独立操作显式清除其秘密。

发现候选顺序：authenticated grant → 实例配置的 credentialRef → GitLab.com 专用 GITLAB_TOKEN/GL_TOKEN refs → GitLab.com 的非交互 glab 探针 → 匿名。自建实例不消费通用 refs 或 CLI；本轮自建 git credential fill 禁用，避免含部署前缀时 helper 共享其他实例 token。CLI 仅身份建立事件 ≤一轮、≤5s；单行无空白/控制字符且有界输出后仍须 GET /user 验证，不要求固定 token 前缀。缺命令/帮助输出不等于有效凭据；接受过身份后 401 不切账号。来源不证明 token 类型或过期时间。

glab 探测结果（含无凭据或非取消的探测失败）仅缓存在所属实例 owner 内；同一身份建立周期的连续/并发业务快照复用候选及已验证身份，不重复启动 CLI。凭据记录/引用失效事件或显式 retry 开启新探测周期；登出、清除 grant 和实例卸载清除缓存。取消或失效后迟到的探测/身份验证结果不得写回。401 保留所选来源与失效 token 指纹，普通快照不得重探测并切换 CLI 账号；显式修复后才重新发现。缓存不改变每操作的 grant 读取/到期刷新、ref 解析、signed-out 抑制或 generation 守护。

**credentialRef 解析规则（G4）**：Host 对已选实例描述中的 ref 调用既有 `ctx.credentials.resolve(ref)`，不将 RPC 提供的 ref 直接传入。首次建立身份、尚未采用任何凭据时，未配置/resolve 返回无值（含空值）视为该来源缺席，跳过到本实例下一来源；不是登录失败。不把存储异常、解析出的非法 token、GET /user 401 或先前使用过的 ref 消失当成“缺席”而换来源：存储故障给可修复读取错误；非法 token、GET /user 401 或已采用来源丢失进入 invalid 并要求显式修复；传输/限流/5xx 保持可重试的验证错误，不换来源，也不宣称 token 本身失效。所有非匿名新 token（包括显式 ref）在其绑定实例经 GET /user 验证后才建立 viewer；该请求属于身份初始化，绝不进入 capability 探测。

每个显式 credentialRef 在配置中只能归属一个规范实例；重复跨实例绑定拒绝。GH_TOKEN/GITHUB_TOKEN 固定属于 GitHub，GITLAB_TOKEN/GL_TOKEN 自动发现固定属于 GitLab.com，其他实例显式引用这些保留名即拒绝；同一 context 中显式与自动路径使用同一 ref 时去重。resolve 只获取值/来源，不证明 token 类型或 host；实例归属由显式配置提供，Host 不将该值用于其他实例。不同 ref 恰巧返回同值也不合并 context 或验证结果；运行时每操作解析、signed-out 抑制与凭据事件失效规则保持。

Device Flow 使用每实例 clientId、api scope；OAuth token body 的实际 expires_in 决定到期。带 refreshToken + store 正向互斥保证才开启两阶段刷新；无 refreshToken 则 automaticRefreshAvailable=false、到期 reauth-required。交换/刷新响应缺 expires_in 时拒绝持久提交 token（不假设永久有效或固定两小时）；token pair 刷新若缺新 refreshToken，不再次使用可能已消费的旧 refreshToken，降为不可自动刷新并按已知新 expiry 重新认证。真实签发行为未实测；两个分支均为必要实现测试。

### D5 HTTP、URL 与预算（GL-R4、GL-R9）

| 用途 | 准入与认证 |
| --- | --- |
| REST | 精确实例 origin 与 `<prefix>/api/v4/` 段边界；Bearer 只在此范围，GET redirect/Link 每跳重新校验；写请求不自动跟随 redirect、不自动重试 |
| Device 初始化 | POST `<prefix>/oauth/authorize_device`；仅 App/scope，无 API bearer |
| Token 交换/刷新 | POST `<prefix>/oauth/token`；仅对应协议 body，禁止泄露到其他网页或跳转 |
| 验证网页 | 精确 HTTPS `<prefix>/oauth/device`；verification_uri 无 query，complete URI 仅单个 user_code 且匹配当前 attempt，不带 bearer |
| 浏览器与头像 | 网页限定已选实例 web 路径，不将同 origin 下其他配置前缀当本实例；头像仅同实例安全路径或 secure.gravatar.com，无 bearer、no-referrer，失败回退首字母 |

Link/cursor 不得改变实例、项目、查询或比较快照；Client 视为不透明 handle，Host 关联 context/generation/query 后校验，不能直接信任响应中的 external_url。按当前单请求页数上限续取；无总体列表天花板。认证缓存键含 scope、viewer、generation、项目 id/path 与完整查询；有 ETag 才条件请求，不依赖 304 免配额。匿名手动刷新，认证轮询至少60s且遵守更长 Retry-After/reset，429/明确限流响应退避。

HTTPS 仅用 Host 信任链；不改全局 dispatcher/信任配置，不关闭证书验证。代理行为按 Host Node 版本/启动配置记录验证结果；本轮不提供自有代理字段或注入网络依赖。显式登记内网目标允许匹配，不自动扫描其他服务。

### D6 动作能力、语义与回执（GL-R3–R8、GL-R12）

v1 actions 的 true/false/unknown 不变。v2 仓库/对象 facts 另加 operationSupport：逐动作 `{supported:boolean,reason?}`，以及 supportedMergeMethods / supportedReviewEvents。不支持的 v2 actions 同时为 false，Host 也拒绝调用。新 Client 不能从 unknown 推导支持，更不能用存储 writable 推权限。

operationSupport、supportedMergeMethods、supportedReviewEvents 的**权威位置统一为 v2 `remote-repository` 的仓库/对象 facts（value 内，与 actions 同层）**，不放在 capability 作为全项目结论。operationSupport 的固定键为 comment/inline-comment/review/close-pr/merge-pr/create-pr，值为 `{supported:boolean,reason?}`；方法集是 merge/squash 的子集，review 事件集是 COMMENT/APPROVE/REQUEST_CHANGES 的子集。不支持 action 必为 false；未确认能力暂为 supported:false + capability-pending；支持度为 true 也仍须独立判断权限三态。项目 tier/策略可收窄平台支持集，不能把实例有某功能直接扩散到全部项目。

v2 remote-repository 请求可带 `object:{kind:'pull'|'issue',number}`；facts 增加 `actionScope:{path,projectId,object?}`，Client 对匹配对象才使用。无 object 时只提供仓库事实，依赖作者、目标分支或具体 MR 状态的权限保持 unknown，不能用来确认对象级写入；确认前需获取匹配对象 facts。已确认支持而权限仍 unknown 时，继续采用 ADR 的乐观尝试/服务端裁决规则。写端点重新以该命令对象计算事实并进行守护，不信任 Client 缓存的 support/method/event 集。审批需要额外认证时可收窄 review 事件集，不能连带禁用可用的普通 comment。

v2 实例级 capability value 必须提供 `authMethods.deviceFlow.supported:true|false|'unknown'` 与可选脱敏 reason，来自 provider 描述和已有初始化结果。v2 loginAvailable = clientId 合法存在且 credential.writable 且 deviceFlow.supported 不为 false；unknown 仅表示允许用户显式尝试/验证，并不保证远端 flow 成功，UI 标明待确认；已知不支持/无 App/不可写则保留禁用的 OAuth 选项并说明原因；CLI 已认证不影响 OAuth 选项展示。该计算不发网络；具体 flow 失败在显式登录后更新已知事实。capability 中保留的 actions 仅是旧形态兼容默认值（已知全局不支持为 false，其余 unknown），不含仓库授权、merge 方法或 review 事件集；Client 在收到对应 facts 前不开放仓库写入。

```json
{"remoteProtocol":2,"scope":{"provider":"gitlab","instance":"https://git.example.com"},"generation":{"instanceId":"runtime-a","revision":2},"value":{"actionScope":{"path":"group/project","projectId":"42","object":{"kind":"pull","number":7}},"viewer":{"host":"git.example.com","userId":"9","login":"reviewer"},"permissions":{},"actions":{"canComment":"unknown","canReview":"unknown","canMerge":"unknown","canClose":"unknown","canCreatePr":"unknown"},"operationSupport":{"comment":{"supported":true},"inline-comment":{"supported":false,"reason":"not-implemented"},"review":{"supported":true},"close-pr":{"supported":true},"merge-pr":{"supported":true},"create-pr":{"supported":true}},"supportedMergeMethods":["merge"],"supportedReviewEvents":["COMMENT","APPROVE"]}}
```

| 动作 / 数据 | 本轮目标行为 |
| --- | --- |
| MR / Issue 读、commits、讨论 | 中立字段 + rawState，Issue 评论只读；只从实际成功响应产生事实 |
| approve / comment | COMMENT 为普通 note；APPROVE 带 head SHA；带正文 approve 按 comment→approve 两步执行，回报每步结果；不收集 approval_password，本轮需额外认证的审批显式受限 |
| request-changes 写 / unapprove | 暂延后，UI 显式不支持；读取已证实的 requested_changes 事实不受此影响 |
| merge | 仅直接合并，支持方法按实例项目策略确认（merge 表示遵循服务端项目策略，不承诺生成 merge commit；squash 需策略允许）；恒传 sha，draft/locked/明确阻断时禁用；rebase/auto-merge/merge train 编排延后 |
| close / create / comment | 无原子 SHA 前置；发送前单快照核对只能 best-effort，非幂等写不重试；创建从允许 source project 已推送分支向允许 target project 建 MR，不建 fork/不 push |
| GitLab locked / 未知 state | v2 locked→open + rawState:locked，禁远端写/不发 closed 通知；取消 phase 字段。rawState 属于 ScopedRemotePull 并承载原始状态，state 仅作中立投影；UI/动作守护显式识别 rawState=locked，不增加第二套枚举。该有限替代已由Accepted的ADR-0005确立为实施目标，保留原历史记录。未知状态使用 v2 unknown/rawState，只读 |
| 权限 | 项目角色、对象作者、分支策略、mergeability、scope 分开保存；缺可靠当前用户事实用 unknown，已知拒绝 false；API 最终裁决 |

v2 写响应 value 为 `{outcome:'succeeded'|'partial'|'unknown',steps:[{kind,state,id?,reason?}],receipt?}`，step state 为 succeeded/failed/unknown/not-sent。已发未知仍用 git/write-result-unknown 的现有错误码及脱敏 flat details，Client 刷新具体对象对账；已知部分成功回 value.outcome=partial，不伪装全成功。approval 失败时不得再次发送已成功 comment；重新确认只重试明确未发送/已知失败的动作。回执不包含原始 HTTP body。

Client 按会话保留 GitLab 待对账状态，侧栏卸载/重挂载不清除。统一控制器按会话+视图（列表与各详情 tab 独立 RPC lane）保留；返回待对账详情页后继续禁止重复写，直到刷新相关对象并由用户确认核对结果；成功的 approve、close、merge 同样遵守此流程。Client 不再有手工平台切换：provider 由 remote-repositories v2 发现的远端 URL 身份自动决定，GitHub/GitLab 共享同一列表/详情/tab UI 组件；无法匹配的远端按 unregistered/ambiguous 逐条提示，不匹配任何受支持 provider 的仓库明确报 unsupported 而非默认 GitHub。GitLab 详情地址使用 `dsh-resource://git-remote/gitlab/<instance>/<path>/<kind>/<number>` 五段语法，GitHub 保留原四段语法，tab 身份互不碰撞。

去重键包含 session/root、scope、project、generation、viewer、requestId；同时保存提交内容指纹，仅进程内比较不记录日志，同 id 不同内容拒绝。去重不承诺 Host 重启或服务端跨请求幂等性；重启后待确认操作仍需对账。

### D7 讨论、Markdown、通知与 Git（GL-R5、GL-R7、GL-R8）

- v2 增加 discussionId/threadId、resolved/resolvable、原始 diff position；旧 reviewId 仅 review 所有者，不借用作线程。保留 old/new line/path、base/start/head、line_range，不以 old_line 存在推 side；无法证明锚点时只展示文本与外链。审批 snapshot 作为当前事实独立显示，不生成假历史；system note 原文可展示，未经结构化证据不解析自然语言生成审批事件。
- 选择经验证共享 Markdown 安全子集：复用正文渲染组件，输入走 provider 投影；GitLab 特有/未知标记保留可读原文，不套 GitHub 特有 HTML 转换规则。无任意 HTML 执行、受控链接/图片/折叠；HTML/实体/恶意 URL 与 GitLab 特有标记 fixture 必须作为 GL4 证据。
- 通知纳入已验证 todo 的 review_requested 及本地 push 后建 MR 建议；自己的 MR 状态变化仅对当前用户已加载/显式跟踪集合按快照差异观察，不承诺全部账号事件覆盖；changes-requested 缺可靠来源则禁用该事件并说明。todo/观察事件去重均含 scope+project+id+状态/时间；不调用标记 todo 完成等写接口。
- HTTPS 与 SSH 按各自映射解析；scp 语法只匹配登记端口22，非默认端口须使用显式 ssh:// URL；别名用 sshHost 映射，不读取或反解 ssh_config；相对 URL 的 HTTPS 前缀与 SSH 仓库路径分开处理。fork 分支用 mr-N（冲突须手动命名）；同库使用 source branch tracking。fetch 仅允许本地 origin/upstream，目标项目 MR ref→私有 ref→核验 SHA→tracking CAS→switch/upstream，保留所有部分回执。缺 head ref 的源项目 fallback 本轮延后，普通 fetch 失败不宣称已清理。

### D8 服务端与操作矩阵（准备项，非兼容承诺）

**用户补充（2026-10-27）**：默认按 GitLab 官方常规部署方式和最新稳定大版本准备，具体细节由用户配置。本次核对的[官方维护策略](https://docs.gitlab.com/policy/maintenance/)与 [19.5 发布说明](https://docs.gitlab.com/releases/19/gitlab-19-5-released/)对应稳定大版本 **19**；准备检查点采用已发布 [19.5.1](https://docs.gitlab.com/releases/patches/patch-release-gitlab-19-5-1-released/)。实际验收前重新核对当前 patch，记录精确版本/镜像 digest，不用滚动 latest 标签充当证据。这是验证目标，不表示全部19.x已支持。

首要场景为常规单节点 CE 或无许可证 EE、无部署前缀、SSH 默认22端口、管理员已配置有效 HTTPS external_url。插件不安装或配置服务器；官方 HTTP 示例不改变本插件 HTTPS 准入边界。用户按 D2 配置 URL、SSH endpoint、端口、前缀、App 与凭据 ref；自定义情形仍属于纳入范围的次要验收车道。付费 tier 策略作为受限场景验证，不假设默认可用。

17.x/18.x 兼容本轮延后，不为每个 provider 操作硬编码任意版本断言。既有 [Device Flow GA 历史](https://docs.gitlab.com/api/oauth2/#device-authorization-grant-flow)仅作为事实依据，不形成最低版本承诺。显式初始化将未验证大版本标为未验证，写入须先有端点/能力证据；元数据缺席不关闭已知安全公共读取或全局 UI。即使19大版本也要覆盖缺 App/flow/字段与权限负向；GitLab.com 按实际 schema 和策略单独验收。

| 能力 | GitHub v1 | GitLab.com / 自建目标 | 负向/受限结果 |
| --- | --- | --- | --- |
| Device Flow | 旧行为保留 | 注册 App + 受支持 flow | 无 App 隐藏；服务端无 flow 不自动转 PKCE |
| API 读/分页 | 旧契约 | MR/Issue/commits/discussions/审批当前事实 | 无权限/缺字段/续页越界分类错误，不捏造空数据 |
| 评论/审批/创建/关闭 | 旧契约 | 逐动作支持与权限守护 | scope/策略拒绝或额外审批认证明确原因 |
| merge / checkout | SHA/CAS 原样保留 | 直接 merge、目标 MR ref checkout | locked/draft/head-moved/ref 缺失不盲重试 |
| reviews/通知 | 旧模型 | 结构化事实 + D7 有限覆盖 | 无历史/事件来源则不伪造 |
| Inline/Issue 写/resolve | 现有 UI 边界 | 本轮不支持 | inline-comment=false并给operationSupport原因；Issue写/resolve本轮无端点及UI入口，Host拒绝 |

### D9 验收规格与冻结缺口

下面为 GL1–GL5 的后续实现验收规格；GL0 的隔离真实 store/服务端证据及冻结结论统一见[计划 B2–B4](../plans/active/remote-platform-integration.md#b2b4-证据与最终冻结复核2026-10-27)，不据此声称 C1–C7 全部执行或用户实例已验证。

| 用例组 | 必须验证的断言 / 证据 |
| --- | --- |
| C1 协议/旧类型 | 旧 Client+新 Host、新 Client+旧 Host、新新、缺 seam；旧 payload/null、v2宣告/回显缺失、顶层与capability内generation不一致、null-generation清理回执不得写确认、作用域不符禁止发写；旧 ./types 调用者编译与 artifact 加载不变 |
| C2 实例/记录 | URL规范化、512-byte上限/base32往返与最大key；同域端口/前缀/大小写不同；grant v1/v2隔离、变址/卸载drain、重复配置/SSH歧义/跨实例ref名复用拒绝；移除scope后跨重启清理零context/网络、记录不匹配保护、清理与refresh/配置并发、缺席/已清理幂等和存储失败 |
| C3 auth | 无/有refresh token、缺expiry、store无互斥、CAS/crash/丢响应、0退出码帮助、初次ref缺席与存储故障/已采用ref丢失/非法值区分、逐实例GET /user验证、保留名/跨host refs、两实例同userId、登录poll/cancel跨scope拒绝；token不进RPC/log/argv |
| C4 HTTP/分页 | redirect/Link/encoded path越界、部署前缀、项目/查询/快照cursor替换、限流、匿名无自动poll、ETag缺失、证书与代理失败 |
| C5 写/权限 | 代发账号/实例/projectId、workspace切换、过时确认、角色非充分证据、仓库/对象级support与方法集、实例flow支持与loginAvailable关系、无phase的locked/unknown原始状态守护、unsupported Host拒绝、重复requestId不同body、comment成功approve失败/未知、merge SHA race |
| C6 Git/Client | 临时仓库dirty/CAS/worktree/single-branch/同iid隔离与部分回执；SSH/HTTPS及prefix fixture、乱序响应、卸载保留本地UI、Markdown/图片/时间线/通知去重 |
| C7 服务端/平台 | GitLab.com、独立域名、内网、非默认端口、prefix、双实例同id；官方常规部署19.5.1准备检查点（执行前复核）、CE/EE与自定义车道、无flow/缺权限能力负向；Windows/Linux/Web/Desktop；记录版本/App/tier/TLS/命令/结果 |

| 冻结证据 | 所需输出 | 当前状态 |
| --- | --- | --- |
| B1 契约复审 | D1–D7 请求/应答、v1兼容、locked映射、支持/延后范围的明确评审结论及后续ADR | G1–G5已通过；ADR-0005 Accepted，GL0设计已冻结 |
| B2 key/运行时边界 | 实际credentials backing store对838字符key的限制/证据；Node/TLS/代理前置 | 两个真实发布 provider 的838-key实证已取得；具体运行时范围/限制以计划证据为准 |
| B3 服务端证据 | D8最新稳定大版本的逐端点字段/权限/tier表、执行时精确patch/digest、自定义车道与相对URL SSH路径证据 | 精确19.5.1文档/hash和逐端点表已取得；部署实测与最终范围见计划 |
| B4 真实验收环境 | 用户提供/另行授权的隔离实例及网络、可信TLS、App/refs、版本与权限场景 | 隔离EE19.5.1基线/前缀/SSH实证已取得；范围/异常见计划，不宣称GL5完成 |

## 影响面

GL1 已涉及 Host 装配、认证/HTTP 描述、ScopedRemote* 类型和 Git remote，v1 适配层仍有维护成本；GL2–GL4 继续按目标实施。发布依赖仍为 registry semver、无 workspace/Electron/运行时 credentials import；兼容车道仍以[唯一 DSH 契约](../reference/dsh-compatibility.md)为准。当前行为见[RPC reference](../reference/remote-platform-rpc.md)，隔离 fixture 与 mock 不等于用户账号登录或真实项目验收。

## 相关文档

- [GL0 评审、冻结清单与阶段进度](../plans/active/remote-platform-integration.md)
- [ADR-0004（现有设计依据，状态不变）](../decisions/ADR-0004-remote-platform-integration.md)
- [当前 RPC 契约](../reference/remote-platform-rpc.md)
- [当前架构](overview.md)
- 官方端点来源：[REST](https://docs.gitlab.com/api/rest/)、[MR](https://docs.gitlab.com/api/merge_requests/)、[Approvals](https://docs.gitlab.com/api/merge_request_approvals/)、[Discussions](https://docs.gitlab.com/api/discussions/)、[To-Do](https://docs.gitlab.com/api/todos/)、[Metadata](https://docs.gitlab.com/api/metadata/)、[相对 URL 部署](https://docs.gitlab.com/omnibus/settings/configuration/#configure-a-relative-url-for-gitlab)。这些来源未证明真实环境或历史精确版本已通过验收。
