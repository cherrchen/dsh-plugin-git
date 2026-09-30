中文 | [English](minimum-release-age-dev-pin.en.md)

# 主 CI 冻结安装因 `minimumReleaseAge` 拒绝开发 pin

## 症状

- `.github/workflows/ci.yml` 的 `verify` 在 `pnpm install --frozen-lockfile` 失败，耗时大约十几秒。
- 日志为 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`，条目都是已提交锁文件里的 `@deepseek-ai/dsh-*@<开发 pin>`，发布时间落在 24 小时冷却窗口内。
- `.github/workflows/upgrade.yml` 矩阵车道仍然通过（该 job 设置 `pnpm_config_minimum_release_age=0`）。

## 根因

主 CI 保留 pnpm 11 默认的 24 小时发布冷却，并且会校验**已提交锁文件**里的条目，不只校验新解析。开发 pin 切到刚发布的 prerelease 后，那一版的传递 DSH 包尚未满一天，冻结安装被拒绝。这与「不要把未承诺或混装的 prerelease 写入 exclude」不是同一件事：后者防止锁文件漂到清单外的版本；前者是让已审查的开发 pin 能被主 CI 装上。

契约见 [DSH 兼容契约](../reference/dsh-compatibility.md) 与 [ADR-0003](../decisions/ADR-0003-dsh-compatibility-contract.md)。

## 解法（已验证）

把**当前开发 pin**在 `pnpm-lock.yaml` `packages` 段里的每个 `@deepseek-ai/dsh-*@<pin>` 精确写入 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`，并**整表替换**，不要把新 pin 追加在旧 pin 后面。

pnpm 11.7 对同一个包名只采用第一条 `name@version` 规则（[pnpm#12463](https://github.com/pnpm/pnpm/issues/12463)）。旧 pin 的条目会让新 pin 的同名包继续受 24 小时冷却约束。若必须保留多个版本，写成一条 `name@a || b`，不要拆成两行。不要：

- 在 `.github/workflows/ci.yml` 把 `pnpm_config_minimum_release_age` 设为 `0`；
- 写入 `@deepseek-ai/*` 这类范围豁免；
- 把未列入支持清单、或不等于当前 pin 的版本写进 exclude。

验证：同一条 `pnpm install --frozen-lockfile` 在保留默认冷却时通过，随后 `pnpm compat:check` 仍只接受锁文件中的 pin 版本。下次再切开发 pin，若新 pin 仍未满 24 小时，用新 pin **替换**这份精确列表。
