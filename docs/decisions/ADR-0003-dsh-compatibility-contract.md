# ADR-0003：以精确版本清单承诺 DSH 兼容性

- **Status**: Accepted
- **Date**: 2026-09-23

## Context

本插件此前把 `@deepseek-ai/dsh-*` peer dependency 声明为 `>=0.1.5-rc.2 <0.2.0`，而开发依赖仅 pin 在 `0.1.5-rc.2`。这让 npm 声明的兼容承诺大于实际验证范围。插件主要依赖公开 Cordis/DSH 服务、类型契约与 `ctx.subprocess`，没有继承或替换宿主 provider；因此兼容声明需要准确，但无需因未知版本阻止插件启动。

## Decision

- `src/compat/dsh-version.ts` 是已验证 DSH 版本的唯一清单。当前包括 `0.1.5-rc.2` 与 `0.1.6-alpha.1`。
- 所有 DSH peers 使用与清单一致的精确 OR 范围；开发依赖统一 pin 在一个已支持版本。当前 pin 为 `0.1.6-alpha.1`。
- `pnpm compat:check` 在主 CI 的测试与构建前校验清单、peers、开发 pin 与本地实际安装版本。
- 独立的手动候选 workflow 将全部 DSH 开发依赖统一切换到指定 prerelease，并运行验证。候选放行只适用于该 workflow，不会自动更新清单或 peers。
- `dsh-client-ui-primitives@0.1.6-alpha.1` 的发布 bundle 导入 `diff`，但上游 manifest 未声明该运行时依赖。本插件将 `diff` 声明为 peer，确保严格包管理器也安装它。
- 当前不做运行时拒绝。若未来依赖宿主内部实现或触及权限边界，再重新评估运行时门禁。

## Alternatives Considered

- **保留 `>=0.1.5-rc.2 <0.2.0` peer 范围**：简单，但会把未经验证的未来 prerelease 视作承诺支持。
- **运行时只警告或拒绝未知版本**：可提示宿主兼容状态，但插件没有高风险 provider 替换耦合；额外启动逻辑会增加维护成本，且无法替代构建与行为回归证据。
- **每次主 CI 矩阵跑遍所有支持版本**：可提供更宽的持续回归，但维护与 CI 成本较高；主 CI 固定当前 pin，候选车道验证升级更符合本包目前的风险和维护规模。

## Consequences

- 新的支持承诺必须经过明确候选版本验证与人工清单晋级，避免宽泛 semver 承诺。
- peer 范围与开发 pin 由脚本严格核对；新增 DSH peer 必须同步加入开发依赖。
- 本插件为目标 DSH prerelease 补充声明了 `diff` peer，以覆盖上游 UI 包当前缺少的运行时依赖声明。
- 主 CI 每次验证当前 pin；历史版本的承诺仍以晋级时的完整验证为依据，不意味着每次提交重跑全部版本。
- 兼容检查的范围是本插件直接声明的 DSH peer 与开发依赖；当前候选锁文件仍有来自上游内部包的 peer 警告，全宿主依赖图验证归上游组合仓库负责。
- 不支持版本在运行时不会被主动拒绝；若上游改变接口导致功能错误，仍需依靠主机升级验证与报告处理。

## Related Documents

- [DSH 兼容契约](../reference/dsh-compatibility.md)
- [范围与需求总览](../requirements/scope-and-requirements.md)
- [工程实践](../development/README.md)
