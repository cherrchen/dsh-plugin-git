# 当前架构总览

- **Status**: Current（以下均可用当前仓库与测试验证）

## 组成

```text
┌─ Host（Cordis plugin，src/index.ts + src/service.ts）──────────┐
│ requires ctx.subprocess，provides ctx.git                      │
│ 每条 git 命令 = 可执行文件 + 分离 argv，绝不 shell              │
│ 可选 Connection 子 fiber：注册 loopback /git RPC 通道           │
└──────────────┬─────────────────────────────────────────────────┘
               │ RPC（status / diff / log / stage / commit / branch …）
┌─ Client（src/client/）─────────────────────────────────────────┐
│ 主 fiber：全部 portable 贡献                                    │
│  · composer 分支选择器 + 变更文件指示器（slot 注入）             │
│  · 三个 Details Host surface：git.changes / git.diff / git.graph│
│  · git-commit-message 设置卡（有 ctx.settingsScope 时）         │
│  · commit message 生成（host LLM runtime，建议式）              │
│ 子 fiber ctx.inject(['desktop'])：reveal / openPath / 通知      │
└────────────────────────────────────────────────────────────────┘
```

## 关键结构事实

- **Host service**：通过 `ctx.subprocess` 启动 `git`（可执行名或绝对路径 + 分离 argv）。Status 用 porcelain v2 + NUL 路径分隔；branches 用 `for-each-ref`；commit 历史用固定字段数的分页 `git log`（`GIT_LOG_FORMAT`），Graph 据此增量加载。丢弃（discard）通过显式的 index / worktree / clean 操作序列实现，Client 侧强制两步确认。
- **RPC**：DSH Web 宿主存在时，Connection 子 fiber 注册 loopback `/git` 通道；过期输出（stale mutation）被丢弃，文件名按字面 pathspec 处理。
- **Details Host 集成**：Client manifest 显式声明 `inject`（运行时依赖 `ctx.shellDetails`）与 `external`（模块表中先物化 Details Host Client 工厂）。三个 surface 各占一个 tab，通过 `ctx.shellDetails.open(...)` 的 create-or-reuse 语义打开；`dedupeKey` 按 workspace path（changes/graph）或 path+staged（diff）收敛重复打开；payload 类型通过 `DetailsSurfacePayloadMap` 模块扩充。tab 栏、Launcher、停靠几何由 Details Host 拥有。
- **可移植 / 原生分离**：主 fiber 不 require `desktop`；子 fiber `ctx.inject(['desktop'], ...)` 只接受 `shell.showItemInFolder`、`shell.openPath`、`notification.show`。缺 Desktop 时核心操作全部可用，仅原生动作不显示。
- **Graph layout engine**（`src/client/graph/`）：纯逻辑模块——不访问 Git、不依赖 React、不触碰 DOM，可独立测试；输出 geometry 与 Canvas 2D 绘制解耦。设计决策与不变量见 [Git Graph Layout Engine](../reference/git-graph-layout.md)、[ADR-0001](../decisions/ADR-0001-graph-lane-not-owned-by-branch.md)、[ADR-0002](../decisions/ADR-0002-graph-lane-cap-max-three-lanes.md)。
- **Commit message 生成**：Host 侧独立 LLM 请求（不经会话上下文，无 KV Cache 影响）；需要 LLM runtime 与可解析模型，否则 Client 报告 `git/generation-unavailable`。配置结构见根 README [Configuration](../../README.md#configuration)（canonical）。

## 验证方式

- `pnpm test`（单元 + 客户端规格，临时仓库与机器可读输出）；
- `pnpm test:artifact`（针对钉住的 Details Host fixture 的集成验证）；
- Graph 拓扑不变量：`tests/graph-layout.client.spec.ts`、`tests/graph-history.client.spec.ts`。

## 相关文档

- [requirements](../requirements/scope-and-requirements.md) —— 架构满足的需求与约束。
- [reference](../reference/README.md) —— Graph layout engine 等稳定技术参考。
