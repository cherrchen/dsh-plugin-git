# Changelog

English | [中文](CHANGELOG.zh.md)

All notable changes to this package are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) — the package is pre-1.0, so a minor release may still change the API. Each published version also has a [GitHub Release](https://github.com/cherrchen/dsh-plugin-git/releases) carrying its tarball.

## [Unreleased]

### Changed

- Extend DSH compatibility to `0.2.1-rc.4` and `0.2.2-alpha.2`, including the optional credentials seam. Accept their host Cordis/schemastery copies while retaining all earlier supported releases and the `0.2.0-rc.2` development pin. See the [compatibility assessment](docs/reference/dsh-compatibility.md).
- Validate unlisted candidates in the isolated local matrix; resolve online lanes from clean dependency trees and check peers to prevent stale Cordis companion packages. Use Node 24.9 for the 0.2.2 alpha CI lane and repair the development lockfile's include peer resolution.

### Fixed

- GitLab authenticated-account and author avatars now display, including Gravatar default avatars.

## [0.2.8] — 2026-10-25

### Added

- Portable GitHub Remote workflows in the right sidebar: PR/Issue browsing, independent detail tabs, PR comments and reviews, verified PR checkout, Issue branches, and protected PR creation from already-pushed branches, closing, and merging. Remote requires the complete optional Host credentials seam; older hosts retain local Git with Remote disabled. Platform login does not configure Git fetch/push authentication. External-platform acceptance remains tracked in the [remote integration plan](docs/plans/active/remote-platform-integration.md).
- A platform-authentication dialog showing the active credential source and account, with GitHub CLI and configured OAuth device-login choices, reconnect/disconnect flows, and isolated credential lifecycle handling. Credential references and Git credential helpers remain supported by the runtime.
- Isolated browser E2E coverage for authentication sources in Chinese and English, disconnect/reconnect, device login/cancellation, token redaction, and independent browser contexts.

### Changed

- Extend verified DSH support to `0.2.1-rc.3` in the canonical release list, `engines.dsh`, and exact peer ranges, including the optional credentials seam. Existing structural adapters remain compatible with navigation customization and model discovery; the development pin stays at `0.2.0-rc.2`.
- GitHub PR/Issue lists, comments, commits, reviews, and comparison files load progressively with cursor continuation, deduplication, cancellation, generation checks, and rate-limit recovery. `RemotePage.next` and the `cursor`/`pages` RPC fields replace the fixed pagination budget; file continuations verify `expectedBaseSha`/`expectedHeadSha` to retain a stable comparison snapshot.
- PR/Issue details use a chronological timeline with comments, commits, reviews, and read-only inline threads grouped under their reviews. File changes open GitHub's Files page. GitHub Markdown and supported HTML render through the Host's Markdown component, with native details disclosures and validated GitHub avatars.
- Remote surfaces use upstream primitives and resource tabs. Git guide entries are grouped together, graph/remote icons are clearer, local Git views retain cached data between visits, and remote loading progress stays visible and responsive.
- Document the upstream Session-log downgrade boundary when newer mandatory events are present.

### Fixed

- Stop detail-load and external-open failures from repeatedly retrying for the same target and revision.
- Recover temporary viewer-lookup failures and reject out-of-range numeric GitHub entity identifiers.
- Preserve legacy Host Markdown rendering and Client bundle compatibility.

## [0.2.7] — 2026-10-17

### Changed

- The exact DSH support list now covers `0.2.1-rc.2`, extending the verified range to every published release from `0.1.5-rc.2` through `0.2.1-rc.2`. The manifest also declares `engines.dsh` with the same exact-version set — the field hosts since `0.2.1-alpha.4` evaluate alone for admission when present — and `pnpm compat:check` keeps it in lockstep with the peer ranges.

## [0.2.6] — 2026-10-15

### Added

- A dedicated **Git Worktrees** sidebar page (`git.worktrees`) lists every checkout of the current repository — regardless of how it was created — marks the current one, and offers **Use in this session** plus a creation dialog (optional branch name and start point). The tab registers only while the Host reports a creation mode via the new `worktree-capability` RPC.
- `create-worktree` RPC and `GitService.createWorktree`: when the host mounts the upstream experimental `worktrees` service, creation delegates to `ctx.worktrees.create(agent, ...)` and the new checkout is entered automatically; otherwise the `git-worktrees` `enabled` setting turns on a local `git worktree add -b` implementation whose pool defaults to `.agents/worktrees` and is configurable via `worktrees.directory`. A fresh in-repository pool gains a self-ignoring `.gitignore` when the host `fs` service is mounted. Deleting and pruning stay outside this package.
- A `git-worktrees` settings section edits `enabled` and `directory` on both supported settings surfaces; saving re-polls the capability so the Worktrees tab appears or disappears without a restart.

### Changed

- The plugin configuration cards now render entirely with `@deepseek-ai/dsh-client-ui-primitives` controls: the generation model is one dropdown listing the session model above provider-grouped catalog entries, and the Worktrees enablement uses the native capsule switch.
- On the plugin bundle page both settings sections now compose into a single full-width settings form with one save — the host's `SettingsForm` where it is exported (DSH ≥0.1.7) and an identical frame on earlier releases — dropping staged edits when the page unmounts. The legacy namespace cards keep their own controls.
- The exact DSH support list now covers every published release from `0.1.5-rc.2` through `0.2.1-alpha.3`: `0.1.5-rc.3` and `0.2.1-alpha.1` were verified and added earlier, closing the remaining gaps in the range.
- `scripts/upgrade-dsh.mjs` and `pnpm compat:check` accept exact-version host runtime pins, matching releases that declare Cordis and schemastery without a caret or tilde (as `0.1.5-rc.3` does).

### Fixed

- The shared configuration page waits for each section's save before fencing the next write, including when the page closes during saving. Transport failures retain editable drafts for retry, and disabling local worktrees explicitly overrides a composition default of `true`.
- A worktree creation's directory projection no longer cancels its own successful RPC reply; controller disposal still cancels in-flight creation.
- Same-directory sidebar mounts no longer cancel a shared refresh or clear the commit draft. Cancelled executable discovery no longer poisons later Git requests or other sessions; successful refreshes also update session capabilities. Changes and Graph display repository-loading failures.
- Upstream worktree creation requires a live session, including submissions from an already-open dialog. The configured local checkout-pool hint appears only in local mode.

## [0.2.5] — 2026-10-11

### Added

- Worktree controls list linked checkouts for the active session's repository. When the host exposes its working-directory service and the session has a live agent, **Use in this session** switches that session to the selected checkout.

### Changed

- Git repository state follows each session's effective working directory, including host-projected directory changes; older hosts continue using the session's original directory.
- Git 0.2.5 supports DeepSeek Harness `0.2.1-alpha.2`, including effective session working directories and linked-worktree switching; `0.2.1-alpha.1` remains unsupported.

### Fixed

- `git worktree list --porcelain -z` paths keep the whitespace Git reported, so **Use in this session** opens that checkout.
- **Use in this session** stays hidden when that session has no live agent, even if the host directory service is installed.
- Overlapping worktree entries run one at a time, and the action stays disabled until the current directory change finishes.

## [0.2.4] — 2026-09-30

Compatibility release extending the exact DSH support list to `0.2.0-rc.2`, with the development pin moved to that release.

### Changed

- Git file comparisons now use the official DSH `DiffBlock` instead of the plugin-owned line renderer and styles. The plugin retains Git fetching and sidebar addresses, supports the existing DSH matrix, and distinguishes binary, metadata-only, empty, incomplete, and end-of-file newline changes. Copying and folding are provided by DSH; newer hosts also provide line wrapping.

- The exact DSH compatibility matrix now includes `0.2.0-rc.1` and `0.2.0-rc.2`. Development dependencies and the committed lockfile pin `0.2.0-rc.2` (Cordis `4.0.4`, schemastery `3.18.4`). Existing structure probes in `src/compat/` still cover settings, schema, and icons. Lane-only packages that this pin publishes (`dsh-util-code-language`, `dsh-client-shortcuts`) are development dependencies only; they stay out of the peer OR.

### Fixed

- Frozen main CI can install the `0.2.0-rc.2` development pin before pnpm's 24-hour release-age window: `minimumReleaseAgeExclude` lists only that pin's exact lockfile packages. pnpm 11.7 ignores later same-name `name@version` rows, so older pin entries are not kept beside it. Unlisted prereleases stay out of that list.

## [0.2.3] — 2026-09-25

Compatibility release extending the exact DSH support list to `0.1.7-rc.2`, with upgrade-lane conditional devDependencies for rc.2-only packages.

### Changed

- The exact DSH compatibility matrix now includes `0.1.7-rc.2`. Development dependencies stay pinned to `0.1.5-rc.2`. Existing structure probes in `src/compat/` still cover settings, schema, and icons.
- The upgrade script adds `@deepseek-ai/dsh-util-code-language` and `@deepseek-ai/dsh-client-shortcuts` as development dependencies only when that exact release publishes them. They stay out of the peer OR range so older hosts keep loading.

## [0.2.2] — 2026-09-24

Compatibility release: one exact DSH support list through `0.1.7-rc.1`, structure-probing adapters in `src/compat/`, and peer OR ranges generated from that list so older hosts keep loading while newer releases are supported.

### Changed

- The exact DSH compatibility matrix now covers `0.1.5-rc.2`, `0.1.6-alpha.1`, `0.1.6-alpha.2`, `0.1.7-alpha.1`, `0.1.7-alpha.2`, and `0.1.7-rc.1`, with development dependencies still pinned to `0.1.5-rc.2`.
- `@deepseek-ai/dsh-*` peer dependencies now use the generated exact OR ranges from that list instead of a single `>=0.1.5-rc.2 <0.2.0` band.
- Cross-release adapters in `src/compat/` probe structure instead of branching on version strings: commit-message settings bridge `settingsScope` and `configForms`; icons map legacy fixed-size exports to 0.1.7 weighted glyphs; schema helpers call `.volatile()` only when the host schemastery copy provides it and snapshot volatile references through `readVolatile`.
- `.pnpmfile.cjs` rewrites transitive `@deepseek-ai/dsh-*` dependencies to the active pin so lockfiles cannot drift to newer prereleases under caret peers.
- `.github/workflows/upgrade.yml` regression matrix is generated from the support list; the upgrade script pins Cordis and schemastery to each release's caret or tilde floor (including `~4.0.4` / `~3.18.4` on `0.1.7-alpha.2` and `0.1.7-rc.1`).
- Client workspace lookup and plugin settings registration span the alpha.2 Session-list and Plugins-tab API changes.

### Fixed

- Declare `simple-icons`, `zustand`, and `immer` as peer dependencies where upstream DSH bundles import them without runtime dependency declarations (`dsh-client-ui-primitives`, `dsh-client-store`).

## [0.2.1] — 2026-09-14

Documentation and reliability release: the changelog and contribution guide arrive, the installation section documents all four install sources, and window-focus churn no longer stacks repository refreshes.

### Added

- `CONTRIBUTING.md` (with the Chinese side `CONTRIBUTING.zh.md`) describing setup, the quality gates, and the documentation duty.
- `CHANGELOG.md` (with the Chinese side `CHANGELOG.zh.md`).

### Changed

- The [installation section](README.md#installation) documents all four install sources — npm registry, tarball, local path, GitHub/git — instead of one npm command plus a local-development snippet.
- A `prepare` script (`pnpm run build`) makes a GitHub/git install build `lib/` from `src/` on the installing machine.
- `pnpm docs:check` also enforces the root bilingual pairs now: `README`, `CONTRIBUTING`, and `CHANGELOG` each need their `.zh.md` side and their `*.i18n.yaml` consistency record.

### Fixed

- Window-focus churn no longer stacks repository refreshes: `GitClientController.refresh()` shares one in-flight round trip per workspace, so repeated focus events cost a single `discover`/`status` pair instead of overlapping rounds that superseded each other's results and left `repository` unset. When a request lands after that round has already read the repository — focus returning after an external edit — the burst adds one trailing read, and merged callers await it, so a fresh edit is never answered by the older snapshot; that trailing read runs even when the shared round failed with a transient discovery or status error. The burst is bounded at two round trips, so the controller's own Host traffic cannot re-arm it forever. Background: [the Windows desktop terminal-window flood](docs/troubleshooting/windows-desktop-console-flood.md).

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

[Unreleased]: https://github.com/cherrchen/dsh-plugin-git/compare/v0.2.8...HEAD
[0.2.8]: https://github.com/cherrchen/dsh-plugin-git/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/cherrchen/dsh-plugin-git/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/cherrchen/dsh-plugin-git/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/cherrchen/dsh-plugin-git/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/cherrchen/dsh-plugin-git/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/cherrchen/dsh-plugin-git/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/cherrchen/dsh-plugin-git/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/cherrchen/dsh-plugin-git/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/cherrchen/dsh-plugin-git/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/cherrchen/dsh-plugin-git/releases/tag/v0.1.0
