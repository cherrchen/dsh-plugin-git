中文 | [English](git-workspace-abort.en.md)

# Git 界面空白与持续 AbortError

## 症状

- composer 的分支选择器、变更计数消失，Changes 只剩「当前分支」标题，Graph 没有历史。
- Worktrees 显示 `This operation was aborted`，再次刷新仍失败。
- 一个会话的首次加载被取消后，其他会话也可能无法加载 Git 数据。
- 工作树已经创建且会话已进入新检出，创建弹窗却仍显示 AbortError。

这些症状与 [RPC 通道 405](git-rpc-channel-405.md) 或 [Windows 焦点风暴](windows-desktop-console-flood.md) 相似，须根据失败原因区分。本条故障链由临时仓库、真实 subprocess 与客户端挂载测试验证；不等同于已在用户的 Desktop 进程内复测。

## 根因

1. composer 与各侧栏共享会话控制器。Changes / Worktrees 挂载时先 `refresh()`，再通过 `useGitWorkspace()` 绑定目录。刷新递增结果 generation，但目录未变；旧的 `setWorkspace()` 幂等判断同时要求 generation 相等，因此把同路径挂载误判为新绑定，取消已有请求、清空仓库数据与提交草稿。这个取消风险在 main 已存在，新增 Worktrees 沿用了该挂载顺序。
2. Host 把第一次 `resolveExecutable(..., signal)` 返回的 Promise 缓存在服务内。该请求若被取消，缓存永久保留 rejected Promise；后续 discover/status/log 直接得到旧的 AbortError，连其他会话也受影响。
3. 首次 discovery 被 refresh 替代时，原绑定后续的能力探测被 generation 检查跳过，而 refresh 原本只更新仓库。目录切换与生成能力因此可能保持初始值。
4. Changes 只在已有仓库时通过提交区显示错误，Graph 只显示 log 错误。discovery/status 失败时，两者没有展示 `state.error`，所以看起来是空白；Worktrees 已展示该字段，才暴露 AbortError。
5. 工作树创建会在 RPC 回执之前发布新目录投影。若已发出的创建请求也使用工作区绑定的取消信号，投影触发 `setWorkspace()` 时就会取消自己的成功回执。

## 解法

- 同一路径的绑定按目录身份保持幂等，与 refresh 的结果 generation 分离。真正换目录仍取消旧请求并重置状态；刷新合并和最多一次 trailing 读取保持不变。
- Git 可执行路径只缓存成功的字符串，不共享携带请求取消信号的在途 Promise；取消或查找失败后允许下一次重试，其他会话不继承该请求的取消。
- 成功 refresh 后重新探测能力，覆盖首次绑定被替代及冷会话变为活跃的情况。
- Changes 在仓库尚未加载时展示仓库错误；Graph 同时展示仓库错误与历史错误。
- 已发出的工作树创建使用独立取消信号，等待回执后结束弹窗；目录重绑定仍取消旧读取与尚未发出的写操作，创建回执不刷新已失效的旧目录。控制器卸载仍取消在途创建。

已经缓存失败 Promise 的旧服务需在加载修复版后重建（重新加载插件或重启 Host）；仅刷新旧版界面无法清掉 Host 缓存。

## 验证

- `tests/service.spec.ts`：真实 subprocess 首次查找中止后，discover/status/log 可恢复；两个会话与重叠 tab 挂载能读取分支、改动、检出及历史。
- `tests/controller.client.spec.ts`：初始绑定与 refresh 重叠、同目录再次挂载时，不取消已有信号、不清空草稿，且能力结果正常发布。
- `tests/git-branch-control.client.spec.tsx`：真实控制器同时驱动 composer、Changes、Worktrees、Graph，验证四处数据均落地。RPC 答案为测试数据，真实 Git 路径由 service 测试覆盖。
- `tests/details-surface.client.spec.tsx`：无仓库快照时的错误可见；上游冷会话禁用创建（包括弹窗内 Enter 提交），本地模式可独立创建，目录提示只在本地模式出现。
- `tests/worktree-endpoints.spec.ts`：真实临时仓库分别经本地与上游委托入口创建，目录投影先于 RPC 回执到达时，客户端仍接受成功结果并显示新检出；`tests/worktree-feature.client.spec.ts` 覆盖卸载取消创建。

相关架构见[总览](../architecture/overview.md)。
