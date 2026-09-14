# Changelog

English | [中文](CHANGELOG.zh.md)

All notable changes to this package are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) — the package is pre-1.0, so a minor release may still change the API. Each published version also has a [GitHub Release](https://github.com/cherrchen/dsh-plugin-git/releases) carrying its tarball.

## [Unreleased]

### Added

- `CONTRIBUTING.md` (with the Chinese side `CONTRIBUTING.zh.md`) describing setup, the quality gates, and the documentation duty.
- `CHANGELOG.md` (with the Chinese side `CHANGELOG.zh.md`).

### Changed

- The [installation section](README.md#installation) documents all four install sources — npm registry, tarball, local path, GitHub/git — instead of one npm command plus a local-development snippet.
- A `prepare` script (`pnpm run build`) makes a GitHub/git install build `lib/` from `src/` on the installing machine.
- `pnpm docs:check` also enforces the root bilingual pairs now: `README`, `CONTRIBUTING`, and `CHANGELOG` each need their `.zh.md` side and their `*.i18n.yaml` consistency record.

## [0.2.0] — 2026-09-14

First public release: `@dsh-electron/dsh-plugin-git@0.2.0` is on npm with build provenance, and its GitHub Release carries the same tarball.

### Added

- Live tab titles for the Changes and Graph tabs.
- `pnpm version:major` / `version:minor` / `version:patch` shortcuts beside `version:set`.
- A spec that fails when a client CSS-module class is not present in the built stylesheet.

### Changed

- **Breaking for the Client half: the Git surfaces moved from the third-party Details Host to the upstream right sidebar.** The package now targets DeepSeek Harness ≥ v0.1.5-rc.2, registers `git.changes` and `git.graph` as page tab types and `git.diff` as a `dsh-resource://git/diff/**` resource type, and navigates through `ctx.sidebarRight`.
- Every `@deepseek-ai/dsh-*` peer range moved to `>=0.1.5-rc.2 <0.2.0`.
- Diff results are panel-local instead of being written into a shared controller slot.
- Panel header actions reuse the shared `GitIconButton`.

### Fixed

- The loopback `/git` RPC channel mounts only once `webServer` exists and reads the connection service from the root context, so it no longer registers against an unresolved `connection`.
- A failed refresh in the Changes or Diff panel renders its error next to the panel fetch error instead of dropping it.
- `npm publish` receives the packed tarball as `./dist/<name>.tgz`: the bare `dist/<name>.tgz` form is parsed by npm as a GitHub `owner/repo` shorthand and fails.

### Removed

- The `@dsh-electron/dsh-client-ui-details-host` dependency and its pinned fixture tarballs.

## [0.1.0] — 2026-09-13

First tagged version: one portable Host service, one Client bundle, and an optional Desktop enhancement.

### Added

- `ctx.git` Host service. It requires `ctx.subprocess` and starts Git with an executable plus separate argv values, never a shell: repository discovery, Git version, current branch and HEAD, porcelain v2 status (staged / unstaged / untracked, NUL-separated paths), local branches, working-tree and staged diffs, stage/unstage, commit, amend, push to `origin`, rebase-then-push sync, branch creation, and branch switching.
- Destructive discard of one staged, unstaged, or untracked change through explicit index, worktree, and clean steps, always behind a second confirmation in the Client.
- Paged commit history (`git log`, one fixed-field line per commit) so the Graph surface appends older commits through a load-more control.
- Commit-message generation: the staged diff (capped by `commitMessage.maxDiffBytes`) goes to the host LLM runtime — the session model, or a `provider`/`model` route pinned in Plugin configuration — and the streamed suggestion is written into the editable message field. It never stages, commits, or pushes.
- Client surfaces on the third-party Details Host (required at that time): **Changes** (branch, commit message with Generate, split Commit button, staged/unstaged/untracked sections), **Diff** (one file per tab), and **Graph** (canvas lane graph with Auto / All / First-parent scopes, at most three visible lanes, incremental paging).
- Composer controls — branch selector and changed-files indicator — that open the Git surface, plus a shared create-branch modal that handles an unborn HEAD.
- Loopback `/git` RPC channel for DSH Web hosts, and a `cordis.patch.yml` bundle layer so one `dsh plugin add` mounts the plugin into a profile.
- Optional `ctx.inject(['desktop'], ...)` child fiber using `shell.showItemInFolder`, `shell.openPath`, and `notification.show`.
- Documentation library under `docs/`, the `pnpm docs:check` machine check, the `version:set` script, a tag-triggered release workflow, the bilingual README pair, and its `README.i18n.yaml` hash record.

[Unreleased]: https://github.com/cherrchen/dsh-plugin-git/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/cherrchen/dsh-plugin-git/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/cherrchen/dsh-plugin-git/releases/tag/v0.1.0
