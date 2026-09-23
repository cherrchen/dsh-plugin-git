# DSH 兼容契约

- **Status**: Current

## 已验证并承诺支持的版本

唯一版本清单位于 [`src/compat/dsh-version.ts`](../../src/compat/dsh-version.ts)：

- `0.1.5-rc.2`
- `0.1.6-alpha.1`

每个 `@deepseek-ai/dsh-*` peer dependency 使用由清单生成的精确 OR 范围。开发依赖统一 pin 到 `0.1.6-alpha.1`，主 CI 验证该 pin；清单表示已验证且承诺支持的版本，不表示每次 CI 都回归所有版本。

`dsh-client-ui-primitives@0.1.6-alpha.1` 的发布 bundle 导入 `diff`，但该包没有将其声明为运行时依赖。本插件将 `diff`（`>=9 <10`）声明为 peer，确保严格依赖解析器也能满足该 bundle 的导入；开发 pin 用于本仓库的 Client 测试。

## 静态一致性门禁

`pnpm compat:check` 在构建之前检查：

1. peer dependencies 是否与精确版本清单一致；
2. 每个 DSH peer 是否有对应开发依赖；
3. 所有 DSH 开发依赖是否 pin 在同一已支持版本；
4. 当前 `node_modules` 中每个已声明的 DSH 包是否存在且解析到该 pin。

主 CI 在测试、文档检查和构建前运行此门禁。锁文件由 `pnpm install --frozen-lockfile` 验证，实际解析版本再由脚本读取。

该检查覆盖本插件直接声明的 DSH peer 与开发依赖，不承诺整个 DSH 宿主依赖树都没有上游 peer 警告。当前 `0.1.6-alpha.1` 锁文件运行 `pnpm peers check` 会报告 Cordis 插件和若干 DSH 内部包的上游 peer 版本不匹配；本插件当前测试与构建仍通过。全宿主依赖图的整合验证需由上游组合仓库负责。

## 候选版本验证与晋级

手动运行 `.github/workflows/upgrade.yml` 并提供一个精确 prerelease 版本。候选车道把所有 DSH 开发依赖统一切换到该版本，然后运行兼容检查、测试、文档检查、构建和 artifact 检查。`DSH_COMPAT_MODE=warn` 只允许此车道验证未列版本；它不修改清单或 peer 声明。

候选车道成功是升级证据，不会自动扩大支持承诺。晋级时应人工审查差异，然后更新唯一清单、peer 范围和开发 pin，并在主 CI 上验证。

本插件使用标准 Cordis 服务、`ctx.subprocess` 和 Client 类型/服务契约，没有替换宿主 provider 或扩大权限的运行时行为，因此当前只设置仓库与 CI 兼容门禁，不在插件启动时拒绝未知宿主版本。若将来引入依赖不稳定上游内部结构或影响安全边界的行为，应重新评估运行时门禁。

## 相关决策

- [ADR-0003：以精确版本清单承诺 DSH 兼容性](../decisions/ADR-0003-dsh-compatibility-contract.md)
