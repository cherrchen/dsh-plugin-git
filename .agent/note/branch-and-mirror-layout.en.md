# Branch topology and the Desktop repository mirror

- **Status**: Current (repository observations; updated 2026-09-14, including a Planned decision recorded the same day)
- **Category**: repository observation / upstream integration / migration background

## Canonical repository and the local mirror

The canonical repository for this package is `cherrchen/dsh-plugin-git` on GitHub (see the `repository` field in `package.json`). The root `AGENTS.md` declares that this local working copy mirrors the canonical repository and must stay independently installable and publishable (registry semver ranges only, never `workspace:`).

## How DeepSeek Harness Desktop integrates this package (subtree mirror → npm package)

- **Current (as of 2026-09-14)**: the root `README.md` states that [DeepSeek Harness Desktop](https://github.com/cherrchen/deepseek-harness-electron) mirrors this repository via **git subtree** and pre-installs the plugin there. Consequences:
  - This repository's commit history also appears in the Desktop repository (subtree merges);
  - The package keeps a self-contained path (a `dsh-plugin-git/`-style subdirectory), so cross-package absolute references must be avoided.
- **Planned (decision of 2026-09-14)**: Desktop will **consume the package published from this repository to npm**, `@dsh-electron/dsh-plugin-git`, and will **no longer** mirror this repository into the `cherrchen/deepseek-harness-electron` Git repository.
  - Prerequisite: a successful first npm release (**done 2026-09-14**; see the [npm-first-release plan](../../docs/plans/completed/npm-first-release.md)) — Desktop cannot depend on a package that does not exist on npm yet.
  - Consequences: upgrading the plugin in Desktop moves from "subtree merge + rebuild" to "bump the npm dependency version"; this repository's `vX.Y.Z` tag → npm publish becomes the single entry point for the version Desktop consumes; the subtree content above then degrades to migration background.
  - When the switch lands: mark this entry Current (drop the present-tense subtree description), sync the root `README.md` / `README.zh.md`, and re-register the `README.i18n.yaml` shas.

## Branch model (conclusions from git archaeology)

- `main` is the primary branch; features and fixes land through PRs (e.g. #2, #4, #5).
- An integration branch `develop` exists: the README compatibility note once said "This `develop` branch targets DeepSeek Harness `v0.1.2`" (updated to `v0.1.5` after the upstream right-sidebar migration); `develop` was merged back into `main` through PR #6.
- When `main` was synced back into `develop` (commit `93ea41f`), conflicts were resolved **in favor of develop**; the local branch `backup/develop-before-sync` is a pre-sync backup of `develop`.
- `audit/0906`, `fix/audit-0908`, and `feat/ui-beauty` are audit/polish work branches; their content reached `main` through rebase/cherry-pick under different SHAs (e.g. `80b1826` vs. `6d10d5f` on main — same subject, different SHA). Whether a branch is merged **cannot be judged by `git branch --merged` alone**; compare commit subjects.

## Upstream version pinning

- devDependencies are pinned to DSH `0.1.5-rc.2` (the npm `next` tag carries every needed package); every `@deepseek-ai/dsh-*` peerDependency uses `>=0.1.5-rc.2 <0.2.0`, explicitly admitting that prerelease baseline and avoiding peer conflicts in strict resolvers.
- The former third-party UI host `@dsh-electron/dsh-client-ui-details-host` is deprecated: this package migrated to the upstream built-in right sidebar (npm `0.1.5-rc.2`), so the pinned `tests/fixtures/` tarball `file:` devDependency workflow (`0.2.0-alpha.4` and `0.3.0`; integrity-refresh history in commits `c09dc1a` and `b4ba876`) is gone.

## Related documents

- [Compatibility and installation (root README)](../../README.md#installation)
- [npm-first-release plan](../../docs/plans/completed/npm-first-release.md) — the first npm release is the prerequisite for Desktop consuming the npm package
- [`.agent/note/README.md`](README.md) — admission criteria.
