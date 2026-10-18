中文 | [English](README.en.md)

# troubleshooting/ —— 复发问题与已验证解法

收录**复发过的、或排查成本高的问题**：症状、根因、已验证的解决方案。

- 准入：问题复发过、或根因需要考古才能找到、且解法**已验证**。一次性报错与未验证猜想不收。
- 条目格式建议：症状（怎么发现）→ 根因（为什么会发生）→ 解法（怎么修的，如何验证）→ 关联提交/测试。
- 本目录文档不强制双语；禁止创建空壳 `.en.md`。

## 条目

- [`git-workspace-abort.md`](git-workspace-abort.md) —— 同目录挂载误取消与可执行文件查找失败缓存叠加，导致 composer / Changes / Graph 空白、Worktrees 持续 AbortError。
- [`git-rpc-channel-405.md`](git-rpc-channel-405.md) —— `/git` RPC 通道 405：cordis 嵌套 fiber 属性访问不可见 `webServer`，通道静默未注册，客户端 UI 全部空白。
- [`minimum-release-age-dev-pin.md`](minimum-release-age-dev-pin.md) —— 主 CI 冻结安装因 pnpm 24 小时发布冷却拒绝未满一天的开发 pin；用当前 pin 整表替换 `minimumReleaseAgeExclude`（同名包只认第一条版本）。
- [`windows-desktop-console-flood.md`](windows-desktop-console-flood.md) —— Windows 桌面端终端窗口风暴与 Git 界面空白：宿主 `CreateProcessW` 缺 `CREATE_NO_WINDOW` 放大焦点事件，客户端刷新无合并且轮次互相判旧。
- [`worktree-endpoints-linux-ci-timeout.md`](worktree-endpoints-linux-ci-timeout.md) —— 兼容矩阵 Linux 车道 `worktree-endpoints` 用例间歇性超时：`dsh-subprocess-local` 每次 spawn 阻塞探测用户 systemd 且只锁正向缓存，尾部无界；该 spec 改为注入直起 `child_process` 的 fake subprocess 服务。
- [`session-log-newer-harness.md`](session-log-newer-harness.md) —— 旧宿主打开新版写入的会话报「历史加载失败」：`0.2.1-alpha.3` 起写入 `job/registered` / `job/settled` 必需事件，更早 harness 的持久化读路径按未知非 ignorable 事件整段拒读，属上游前向兼容防护而非插件缺陷。
