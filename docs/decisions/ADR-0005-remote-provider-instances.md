中文 | [English](ADR-0005-remote-provider-instances.en.md)

# ADR-0005：Remote 多实例、版本化协议与孤儿授权清理

- **Status**: Accepted（GL0设计冻结；GL1按后续授权实施）
- **Date**: 2026-10-27

## Context

[ADR-0004](ADR-0004-remote-platform-integration.md)的首期 GitHub 已有已发布 RPC/类型；GitLab.com 与 Self-Managed 纳入同一插件后，需要多实例隔离、可替换 provider、旧新 Host/Client 兼容及移除实例后的授权清理。用户已复核通过[计划中的 B1 G1–G5 修订](../plans/active/remote-platform-integration.md)，确认 instance retirement、统一 generation、rawState、逐实例 ref 与能力归属的方向。

本文记录长期取舍及原因；[多实例设计稿](../architecture/remote-platform-instances.md)是详细字段、算法、协议示例与用例的唯一维护位置，计划维护状态与证据。B2–B4 已取得有界真实store、精确版本文献和隔离服务端准入证据；[计划最终冻结记录](../plans/active/remote-platform-integration.md#b2b4-证据与最终冻结复核2026-10-27)维护结果、异常与未验证范围，不将其扩大为GL5验收。

## Decision

以下决策按用户最终冻结指示接受为GL0设计基线；当时接受设计本身不启用GitLab或授权GL1，后续实施授权和状态见计划：

1. **接口 + 组合 + 实例注册表**。业务编排只依赖 ScopedRemoteProvider；GitHub/GitLab 适配器通过实例描述注入认证与 HTTP 策略。GitLab.com 与自建实例复用同一平台适配器，以规范 URL 分隔上下文、凭据、缓存、请求与生命周期，不按每个 origin 建子类。沿用 ADR-0004 credentials seam 硬门禁与 portable 主 fiber / Desktop 子 fiber 边界。
2. **显式协商 v2，保留 v1 语义**。旧导出类型、无作用域 GitHub RPC 与 grant v1 保留；v2 由 Host 应答宣告后才能使用，并逐成功应答核对 remoteProtocol/scope/顶层 generation。capability 内保留的 generation 必须同值；void=value:null、retire 的 generation:null、发现与控制错误的例外按设计稿 D3。不得将缺少回显的 v2 请求退回无作用域写入。
3. **规范实例身份与独立 grant v2**。采用设计稿 D2 的先校验后 URL 规范化和可逆 base32 host-id（含内建实例特例与长度上限）；D4 的 provider/instance/App/grant 绑定不改旧字段含义。838字符 record key 的真实存储实证已在B2限定的两个provider/运行时组合内取得，不由编码算法推导其他store兼容。
4. **纯存储 retire，保留退出抑制**。新增 v2 remote-retire-grant 处理已移除实例：对输入执行完整规范化后推导 key，而非只接受已规范的字面量；大写域名/默认端口/末斜杠等规范等价输入可用，危险格式仍拒绝。仅接受本插件可证明绑定的 GitLab v2 记录；通过 modifyRecord 写无秘密 retired signed-out 标记，令旧刷新意图失效，既不无条件删除也不建立 context/网络信任。正常 clear-grant 的删除/恢复发现语义不变。此路径不依赖 listRecords，不扩展当前 seam 探测面。
5. **凭据来源按实例绑定，动作能力按对象归属**。resolve(ref) 由 Host 配置寻址；初次无值、存储故障、非法/失效或丢失已用来源、网络验证失败分别处理，不借失败换身份。capability 只提供认证方法的已知事实并保持零网络；operationSupport/方法集/review事件集与 actions 同属于仓库/对象 facts，Host 写前重算，不用 unknown 代替实现支持。
6. **GitLab locked 在 scoped v2 投影为 open，保留 rawState**。rawState=locked 时禁止远端写及 closed 通知，不增加 phase 枚举；未知原值只读。此选择使 UI 不因中立 closed 投影推断对象已终止，同时完整保留平台状态。本ADR获Accepted后，仅替代ADR-0004历史评审中的GitLab locked→closed映射作为scoped v2实施目标；ADR-0004其余决策、GitHub状态规则及其Proposed状态保持，历史评审原文不改写。
7. **证据与准入分离**。B1修订和B2–B4限定证据支持GL0设计冻结，不是GL5真实验收完成。保留设计稿 D8 的官方默认部署/最新稳定大版本目标、次要自定义实例车道，以及明确延后的操作；实现退出仍取决于 C1–C7 和全部适用前置证据。所有 P1 闭合并获用户明确实施指示前不进入 GL1。

## Alternatives Considered

- **业务层增加平台分支或继承基类集中流程**：实现初期直观，但会把平台条件、实例生命周期和认证差异推回编排或父类；接口 + 组合更易替换与逐实例测试。
- **每个 origin 建子类**：域名配置变化不是平台协议变化，复制实现会增加维护面；真实协议差异才另评估专门适配器。
- **原地扩大 v1 类型/动作枚举**：可能打破已发布调用者，旧 Client 对新非 false 字符串会放行；采用新 scoped 类型与显式版本协商。
- **删除实例即丢掉旧 key 的清理入口**：产生不可达秘密；保留格式合法 URL 的纯存储 retire 操作，不重建网络上下文。
- **先读再无条件 deleteRecord，或返回 undefined 假定 CAS 删除**：deleteRecord 无条件删除，modifyRecord 的 undefined 是不修改；选择原子替换退出标记，保留抑制与刷新 CAS 保护。
- **为清理引入凭据枚举**：上游可提供 listRecords，但当前锁定 seam 探测清单不要求它；本轮用已知旧 URL 处理，无需新增依赖。未来枚举是单独 seam 扩展决策。
- **继续将 locked 当中立 closed**：会增加 UI/通知误认终态的风险；选择 scoped v2 open+rawState+禁写，并保留兼容历史与正式替代关系。

## Consequences

正面：既有 GitHub 与旧 Host/Client 边界可追踪；自建实例共享实现而隔离身份；移除后秘密仍可安全处理，不靠枚举或网络。代价：增加 v1适配/v2信封与 retired 标记维护，Client 必须区分仓库/对象能力与认证方法，真实 store/服务端测试不能省略。

GL0设计已冻结；后续用户已单独授权GL1，当前落地行为见[RPC reference](../reference/remote-platform-rpc.md)，阶段与证据见计划。本文Accepted与设计稿Target不代表GL2–GL5或真实验收完成。ADR-0004不因这份范围有限的决策而整体标为Superseded。

## Related Documents

- [B1复核、GL0状态与外部证据](../plans/active/remote-platform-integration.md)
- [详细多实例/协议设计 D1–D9](../architecture/remote-platform-instances.md)
- [ADR-0004：首期决策与历史状态映射](ADR-0004-remote-platform-integration.md)
- [当前远程 RPC 契约](../reference/remote-platform-rpc.md)
- [DSH 兼容契约](../reference/dsh-compatibility.md)
