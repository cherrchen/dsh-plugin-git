中文 | [English](remote-platform-rpc.en.md)

# 远程平台 RPC 契约（remote-*）

- **Status**: Current（实现与 mock/临时仓库验证；真实 OAuth、远端写入及平台手工验收仍 Not verified）
- **设计权威**：[ADR-0004 Decision](../decisions/ADR-0004-remote-platform-integration.md#decision)（Proposed）与[实施计划](../plans/active/remote-platform-integration.md)。

## 门禁与生命周期

`/git` 通道在缺少完整 credentials seam 时整功能关闭：结构性检查 `readRecord`、`modifyRecord`、`deleteRecord`、`resolve`、`describe`、`describeRecord`、`notifyRecordUpdated`，允许原型方法，绝不调用事件发射方法。缺失成员只回传允许名单名称，getter/存储/进程/网络错误不透传 secret 或原始诊断。

Host 的 credentials 子 fiber 拥有认证、REST、缓存与子进程工作。卸载先停止准入并取消、等待在途工作；本地 Git service 和 Client Changes/Diff/Graph/Worktrees 保留。Client 主 fiber 每 5 秒探测 capability，按 on/off 注册、注销 `git.remote` type/body/title；请求按会话与仓库绑定，目录变化取消旧请求，账户/generation 变化丢弃旧数据。Desktop 子 fiber 仅增强通知，不拥有核心 UI。

credentials 使用本地结构契约，无运行时或发布声明包导入，旧宿主无此包时仍能构建和加载。兼容车道见 [DSH 兼容契约](dsh-compatibility.md)。

## `remote-capability`

payload 忽略（含 `null`）。无 seam 返回 `{ state:'off', reason:'credentials-missing', auth:{state:'off'} }`；不完整 seam 返回 `credentials-incomplete` 与 `missing`。`implementation-pending` 保留为运行时未装配时的安全兜底。

完整 seam 的应答为 `{ state:'on', generation, credential, auth, actions, loginAvailable, automaticRefreshAvailable }`。capability 不启动子进程或网络，只读取存储描述与已知的内存认证状态。`credential.configured/writable` 不表示已认证或远端写权限；初始 `auth.state` 为 `unauthenticated`，动作是 `unknown`。仓库 viewer、permissions 与动作事实由 `remote-repository` 单独返回。

`generation = { instanceId:string, revision:number }` 对 Client 不透明；Host 重建时 instanceId 不复用。viewer 的稳定身份为 `{host,userId}`，login 仅展示。同一 generation 至多一次 `GET /user`；显式重试会创建新 generation，失败 token 不会因重试自动回退到其他账号。

## 配置与认证

`src/remote/settings.ts` 是配置解析/验证真源，schema 位于 `src/index.ts`。字段均为可选 volatile：

| 字段 | 默认 | 语义 |
| --- | --- | --- |
| `clientId` | 无 | Device Flow 公共 client_id；缺少时隐藏登录，发现链仍可用 |
| `requestTimeoutMs` | `15000` | HTTP 请求总超时，含全部重定向和正文读取 |
| `probeTimeoutMs` | `5000` | 非交互凭据探针超时，范围 1–5000 ms |
| `refreshTtlMs` | `30000` | 刷新持久意图及旁观等待 TTL |
| `refreshPollMs` | `250` | 旁观间隔，正值且不大于 TTL |
| `refreshStoreExclusive` | `false` | 部署方对 store 跨进程 `modifyRecord` 互斥的正向保证；缺少时不自动旋转 |
| `maxResponseBytes` | `4194304` | 单响应正文上限，流式读取超限立即取消 |

GrantRecord v1 的键为 `dsh-plugin-git/github-com`；迁移通过 `modifyRecord` CAS，提交使用新的 revision。发现链为 authenticated grant → `GH_TOKEN`/`GITHUB_TOKEN` ref → `gh auth token` → 匿名，ref source 以 provider 为准。ref 每操作重解析；gh 只在身份建立/事件/显式重试中运行，不能随 REST 分页反复启动。401 把该 token 标为 invalid，不自动换账号；曾有凭据后丢失不会静默变成匿名。`git credential fill` 仅用户显式触发，固定 hostname 经 stdin 输入，输出不进入 RPC、日志或 argv；所有探针非交互、≤5s、有界收集并等待退出。

| 认证端点 | payload / 结果 |
| --- | --- |
| `remote-login` | `{}` → `{attemptId,userCode,verificationUri,expiresAt,intervalMs}`；只发射用户码，不发射 device_code/token |
| `remote-poll-login` | `{attemptId}` → `{state:'authenticated'}`；共享同 attempt 的轮询，累计 slow_down，取消/拒绝/过期不提交授权 |
| `remote-cancel-login` | `{attemptId}`；取消轮询并 CAS 结束该 attempt |
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
| `remote-pr` / `remote-issue` | `number`；PR 显式保存 head/base 仓库、ref、SHA；state 为 open/closed/merged，保留 rawState |
| `remote-comments` | `number,inline?:boolean, cursor?, pages?`；inline 保存 replyTo、commitSha、原始行/side 与 `reviewId`（归属的 review id，供按 review 分组展示），outdated 不冒充当前坐标 |
| `remote-commits` | `number, cursor?, pages?`；返回 `{items,truncated,next?}`，commit 为 `{sha,subject,author,date?,url?}` |
| `remote-reviews` | `number, cursor?, pages?`；返回 `{items,truncated,next?}`，review 为 `{id,author,state,rawState,body,url?,submittedAt?,commitSha?}`，`state` 归一为 `approved|changes-requested|commented|dismissed|pending` |
| `remote-files` | `number, cursor?, pages?, expectedBaseSha?, expectedHeadSha?`；返回 `{files:{items,truncated,next?},baseSha,headSha}`；首页读取前后核对 PR 快照，续页携带 expected SHA 并逐页核对 head/base 未动。PR 详情页不主动调用：文件改动经 `pr.url + '/files'` 跳转 GitHub Files 页查看，该能力保留给需要本地坐标的受守护写路径 |
| `remote-notifications` | `automatic?:boolean`；review request、自己 PR merged/closed/changes-requested，稳定事件 id；最多展开 10 个通知线程，超限标 truncated |

API token 仅发往 `https://api.github.com`，带 `X-GitHub-Api-Version:2022-11-28`；Link 与 GET 重定向也校验该 origin。浏览器 URL 独立只允许 `https://github.com`。响应显式投影成中立模型，不透传 raw 对象。认证 ETag 正文按 origin/viewer/generation/完整路径与查询隔离；身份变化清空。匿名不自动轮询，认证轮询最短 60 秒且遵守更长的 X-Poll-Interval；429、primary/secondary 403 遵守 Retry-After/reset 与有界指数退避，不自动重试写请求。

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
