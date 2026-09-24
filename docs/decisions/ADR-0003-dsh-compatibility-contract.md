# ADR-0003：以精确版本清单承诺 DSH 兼容性

- **Status**: Accepted
- **Date**: 2026-09-23

## Context

本插件此前把 `@deepseek-ai/dsh-*` peer dependency 声明为 `>=0.1.5-rc.2 <0.2.0`，而开发依赖仅 pin 在 `0.1.5-rc.2`。这让 npm 声明的兼容承诺大于实际验证范围。插件主要依赖公开 Cordis/DSH 服务、类型契约与 `ctx.subprocess`，没有继承或替换宿主 provider；因此兼容声明需要准确，但无需因未知版本阻止插件启动。

## Decision

- `src/compat/dsh-version.ts` 是已验证 DSH 版本的唯一清单。当前支持版本及开发 pin 见[DSH 兼容契约](../reference/dsh-compatibility.md)。
- 所有 DSH peers 使用与清单一致的精确 OR 范围；开发依赖统一 pin 在一个已支持版本。
- `pnpm compat:check` 在主 CI 的开发 pin 车道及升级 CI 的其余兼容版本车道的测试与构建前校验清单、peers、矩阵 pin 与本地实际安装版本；仓库默认开发 pin 作为冻结锁文件的基线。
- 手动候选模式将全部 DSH 开发依赖统一切换到指定 prerelease，并运行验证。候选放行只适用于该次运行，不会自动更新清单或 peers。
- 上游 UI primitives 发布 bundle 导入 `diff`，但 manifest 未声明该运行时依赖。本插件将 `diff` 声明为 peer，确保严格包管理器也安装它；候选兼容记录中的其他上游遗漏见兼容契约。
- 当前不做运行时拒绝。若未来依赖宿主内部实现或触及权限边界，再重新评估运行时门禁。

## Alternatives Considered

- **保留 `>=0.1.5-rc.2 <0.2.0` peer 范围**：简单，但会把未经验证的未来 prerelease 视作承诺支持。
- **运行时只警告或拒绝未知版本**：可提示宿主兼容状态，但插件没有高风险 provider 替换耦合；额外启动逻辑会增加维护成本，且无法替代构建与行为回归证据。
- **每次主 CI 都运行全部版本矩阵**：能统一展示所有证据，但会让开发 pin 的常规门禁重复执行多次。将主 CI 固定在开发 pin，并让升级 CI 回归其余支持版本，仍能持续覆盖全部承诺版本且更清楚区分默认工作环境与兼容承诺。

## Consequences

- 新的支持承诺必须经过明确候选版本验证与人工清单晋级，避免宽泛 semver 承诺。
- peer 范围与开发 pin 由脚本严格核对；新增 DSH peer 必须同步加入开发依赖。
- 本插件为上游 UI bundle 补充声明其缺失的 runtime peers，以覆盖上游 manifest 遗漏。
- 主 CI 每次验证开发 pin；升级 CI 动态枚举并验证清单中的所有非默认兼容版本。仓库锁文件保留单一开发 pin，便于本地开发并明确默认基线。
- 兼容检查覆盖直接声明的 DSH peer 与开发依赖，并要求锁文件中每个 `@deepseek-ai/dsh-*` 都等于当前 pin。非 DSH 的宿主依赖图验证仍归上游组合仓库负责。
- 不支持版本在运行时不会被主动拒绝；若上游改变接口导致功能错误，仍需依靠主机升级验证与报告处理。

## 后续修正（2026-09-23）：宿主运行时副本不能被新版本漂走

把 Cordis peer 下限抬到 `>=4.0.3`、并把 schemastery 依赖下限抬到 `>=3.18.3`，会让 0.1.5-rc.2 与 0.1.6 的宿主失去可加载的插件：那些发行版带的是 Cordis `4.0.2` 与 schemastery `3.18.2`。`3.18.2` 没有 `Schema.prototype.volatile`。插件在求值导出的 `Config` 时无条件调用它，入口模块直接抛出 `volatile is not a function`。主 CI 与当时的矩阵把这两份运行时漂到了 0.1.7 的副本，所以这条加载失败没有被测试看见。

修正：`src/compat/dsh-schema.ts` 按方法是否存在决定是否标记 `volatile`；Cordis peer 回到 `>=4.0.2 <5`；schemastery 依赖回到 `>=3.18.2 <4`。开发 pin 与每个矩阵车道把 Cordis、schemastery 钉到该 DSH 版本声明的 caret 下限。`pnpm compat:check` 核对解析结果等于这个下限。

## 后续修正（2026-09-24）：整棵 DSH 树只能有一个版本

根清单把直接依赖写成精确版本之后，上游包自己的 peer 仍是 `^0.1.5-rc.2` 或 `^0.1.1-rc.2`。pnpm 打开 `autoInstallPeers` 时会把这些范围解到 registry 里更新的 prerelease，开发 pin 的锁文件因此混入 `0.1.5-rc.3` 和 `0.1.7-alpha.1`。兼容矩阵在 `0.1.7-rc.1` 发布后以同样方式漂走，下一条 pnpm 命令又恢复 24 小时发布冷却，于是安装通过、`compat:check` 失败。

修正：`.pnpmfile.cjs` 把传递 DSH 依赖、可选依赖和 peer 全部改成当前 pin。主 CI 继续冻结锁文件并保留默认冷却。只有兼容矩阵 job 设置 `pnpm_config_minimum_release_age=0`。不把新出现的 prerelease 写入 `minimumReleaseAgeExclude`，也不在 `pnpm-workspace.yaml` 全局关闭冷却。`pnpm compat:check` 拒绝锁文件里任何一个不等于 pin 的 `@deepseek-ai/dsh-*`。

## Related Documents

- [DSH 兼容契约](../reference/dsh-compatibility.md)
- [范围与需求总览](../requirements/scope-and-requirements.md)
- [工程实践](../development/README.md)
