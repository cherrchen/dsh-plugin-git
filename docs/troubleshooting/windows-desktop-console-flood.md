# Windows 桌面端：打开后终端窗口风暴与 Git 界面空白

## 症状

Windows 桌面端（Electron）打开应用后：

- 屏幕上持续出现大量控制台/终端窗口，内容形如「已退出进程，代码为 0…」。每个窗口一闪即走，数量随宿主的 git 调用增长。
- Git 界面不渲染：composer 的分支选择器与变更 chip 不出现，Changes / Diff / Graph 正文空白；过程中可能**没有**任何可见错误。
- Web 端（DSH Web 宿主）不复现。

退出码为 0 与「界面异常」并不矛盾：命令本身执行成功，问题在调用频率与结果归属，见根因 ②。

## 根因

分属两个仓库，只有 ② 在本仓库。

### ① 终端窗口本身：宿主 Windows 子进程路径（`deepseek-harness-electron`，本仓库不能修）

- `packages/subprocess/win32-process/src/process.ts` 的 `spawnCurrentTokenJobProcess` 以 `CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT` 调 `CreateProcessW`，没有传 `CREATE_NO_WINDOW`（该包的 `abi.ts` 里也没有这个常量）。
- `packages/subprocess/subprocess-local/src/windows-job.ts` 启动 Job runner 时没有传 `windowsHide`（同包的兜底路径 `spawn.ts` 传了）。
- 桌面端 harness 跑在 `electron.exe` 里（`ELECTRON_RUN_AS_NODE`、GUI 子系统、无控制台），而 `git.exe` 是控制台子系统程序：Windows 于是为**每条** git 命令新分配一个可见控制台窗口。

这一层的修复（补 `CREATE_NO_WINDOW` 与 `windowsHide`）属于后继变更，不在本仓库范围内。

### ② 界面空白：本仓库的刷新放大与互相判旧

- `src/client/GitBranchControl.tsx` 的 `window` focus 监听无条件调用 `controller.refresh()`；surface 挂载刷新与手动刷新按钮走同一个入口。
- `GitClientController.refresh()` 每轮都 `++this.operationGeneration`，而 `loadRepository()` 用 `isWorkspaceCurrent()` 检查 generation：**重叠轮次里较早的那轮结果被整批丢弃**。
- ①制造的每个控制台窗口的弹出/关闭都会产生焦点事件，于是焦点抖动 → 任意多轮并发刷新 → 每轮 5 条 git 命令（`discover` 1 条 `rev-parse` + `status` 的 `rev-parse` / `--version` / `status --porcelain=v2` / `for-each-ref` 4 条）。
- 更糟的是这些轮次**互相判旧**：没有哪一轮能同时守住 generation 与错误状态，`repository` 迟迟不落地，界面于是不渲染。

## 解法（已验证）

`GitClientController.refresh()` 改为合并入口：同一工作区在途的刷新被复用（一个 burst 最多两轮 Host 往返，而不是每个焦点事件一轮）。

- 复用键同时含工作区 `path` 与 `generation`——`setWorkspace()` 会 bump generation，跨绑定的旧在途轮次绝不能被复用。
- 被复用的轮次结束后在 `finally` 中做身份比较并释放槽位，否则刷新只会发生一次。
- **复用只在该轮尚未发出 `status` 读取时成立**：该轮的读取紧随请求之后，看得见请求所代表的改动，故不需要额外往返。若请求在该轮读取之后到达（例如外部编辑后的焦点回归），该轮记一次 **trailing 读取**，合并进来的调用方 await 到这轮 trailing 读取落地——不能拿旧快照回答新请求，否则界面会一直停在改动前的状态，直到下一次焦点或手动刷新。
- **trailing 读取在共享轮次失败时同样执行**：请求是被"读取已发出"这一事实判定的，与那轮最终成败无关；`discover`/`status` 的瞬时失败不得吞掉请求，否则界面会停在错误态直到下一次事件。保留 generation 检查，仍最多补读一轮。
- **一个 burst 最多两轮往返**：trailing 轮不再递归链接。控制器自身的 Host 流量在 Windows 上会持续产生焦点事件（每条 git 命令弹出控制台窗口），若无界链接，burst 会自激成永久刷新循环；有界两轮既能覆盖「读取之后的请求」，又保证终止。
- 原刷新体原样下沉为私有方法 `reloadRepository()`；`setWorkspace()`、`GitBranchControl` 的 focus 监听、surface 挂载刷新、手动刷新按钮都不改，它们共用同一个合并入口。
- 宿主侧的窗口旗标不在本仓库：本次不预留开关、不加配置项。

## 验证

- `pnpm test`，`tests/controller.client.spec.ts` 的三个用例固化新行为：
  - `collapses overlapping refresh calls into one Host round trip`：同一工作区两次并发 `refresh()`（`status` 被门控挂起）只产生 1 次 `discover` + 1 次 `status`，两次调用都 resolve 且 `repository.root` 落地；轮次结束后再刷新一次，`discover` 计数变为 2（证明复用槽位已释放）。
  - `runs one trailing read when a refresh lands after the round captured its snapshot`：等第一轮发出 `status` 后再 `refresh()`，第一轮以旧快照 `before-edit` 收尾 → trailing 轮发出第二次 `discover`/`status`，前两次调用的 promise 到此时才 resolve；trailing 读取期间再来的第三次 `refresh()` 只并入该 burst（不产生第三轮），最终 `repository.head` 为 `after-edit`。
  - `retries the requested trailing read when the shared round failed`：同样在读后 `refresh()`，第一轮以 `{ ok: false, error: 'transient status failure' }` 收尾 → trailing 读取仍发出并以正常快照落地，两次调用都 resolve，`error` 被清空、`repository.root` 落地。
- 三条用例都在未修复实现上失败：第一条 2 次 `discover`（无合并），后两条各只有 1 次 `status`（无 trailing 读取；其中第三条正是"失败吞掉请求"的回归）——它们守得住这三个方向。
- 未做 Windows 实机复现（开发机为 macOS，且终端窗口属另一仓库）：本仓库的交付边界是「一次焦点 burst 最多两轮 Host 往返、每轮结果都能落地、读取之后的请求不会被旧快照回答」。

## 关联

- 用例：`tests/controller.client.spec.ts`（`GitClientController` 一组）。
- 现象来源：`cherrchen/dsh-plugin-git` issue #8。
- 同目录先例：[`git-rpc-channel-405.md`](git-rpc-channel-405.md) —— 同样是「界面空白 + 命令本身成功」的症状，根因在通道注册而非 Git 命令。
