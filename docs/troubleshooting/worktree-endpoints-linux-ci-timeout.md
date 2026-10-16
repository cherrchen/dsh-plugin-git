# 兼容矩阵 Linux 车道 `worktree-endpoints` 用例间歇性超时

## 症状

- `.github/workflows/upgrade.yml` 的 `verify (<版本>)` 车道偶发失败，报 `tests/worktree-endpoints.spec.ts` 中 `accepts local/upstream creation when its directory projection arrives before the RPC reply` 单测 `Test timed out in N ms`，同一次运行其余 298/299 用例全绿。
- 同一提交重跑即过；通过时整份 spec 约 5–7 秒，失败时单测顶满超时上限（20s 与 60s 均被顶满过），说明不是匀速变慢而是阻塞/尾部爆炸。
- 失败集中在最老车道（`0.1.5-rc.2` 三次、`0.1.5-rc.3` 一次），但探测代码在 `0.2.0-rc.2` 及以前完全一致，任何走真实 spawn 的车道理论上都可能踩中。
- macOS 本地无论如何复现不了（见根因）。

## 根因

`@deepseek-ai/dsh-subprocess-local`（≤ 0.2.0 各版本实现一致，`0.2.1-alpha.x` 起改为 selector 重构）在 Linux 上**每次** `spawn()` 都执行 `selectContainmentMode` → 阻塞式 `spawnSync` 探测用户级 systemd：

- 深探针（`probeLinuxScope`）真实创建 `systemd-run --user --scope` 瞬态 scope，`SYSTEMCTL_TIMEOUT_MS` 上限 5 秒；
- 深探针成功后每次 spawn 仍要 `spawnSync systemctl --user show`（`probeLinuxManager`），同样最长 5 秒；
- 正向缓存 `linuxDeepProbePassed` **只锁成功**：用户 manager 一过载导致探测失败，其后每个 spawn 都重新支付完整深探针；该 spec 失败用例是全仓单测 spawn 最多的（两轮 workspace 装载 + 真实 `git worktree add` + controller 重入），十几次 spawn 叠加即顶破任何常规超时；
- `spawnSync` 阻塞 vitest worker 事件循环，测试内并发的 controller↔host 重入链一起被拖住。

macOS 上 `selectContainmentMode` 直接走 fallback，零探测开销，本地恒 <1s；CI ubuntu 上 32 份 spec 并行、各 Context 实例同时探测同一用户 manager，自挤兑突发时尾部无界。

## 解法（已验证）

`tests/worktree-endpoints.spec.ts` 不再经 `ctx.plugin(LocalSubprocessRuntime)` 取真实运行时，改以 `ctx.provide('subprocess', localSubprocess())` 注入一个 `child_process.spawn` 直起的 fake（实现 `resolveExecutable`/`spawn`/`done`/`collected`/`waitForExit`/`terminate`）。该 spec 的验证目标是会话/RPC/重入时序语义，真实 git 语义由 fake 下的真实 `git` 子进程完整保留（`git worktree add`、`existsSync` 断言不变），而 systemd 容器路径并非本 spec 的受测对象——真实运行时集成覆盖仍在 `service.spec.ts` 与 `worktree-create.spec.ts`。

配套判断：

- 不继续加超时：60s 已被顶满过一次，探测尾部理论无界；
- 不加 vitest `retry`：重跑再付一遍探测成本，且掩盖真实重入回归；
- 不改 `ctx.subprocess` mock 空对象：用例价值恰在真实 worktree 创建与 RPC 重入；
- 无法在上游包侧关闭探测：`selectContainmentMode` 无配置入口，正向缓存不可注入（0.2.1-alpha.x 重构后探测改走 listener+缓存，老车道不会回流）。

残余风险：`service.spec.ts`、`worktree-create.spec.ts`、`session-directory.spec.ts` 仍走真实运行时（它们是集成 spec，真实运行时即受测对象），同一机制理论上也可能让它们超时；目前未观察到，若复发再按本条模式处置。

验证：本地 spec 584ms 全过；CI 侧观察后续矩阵 run 该用例不再顶格。
