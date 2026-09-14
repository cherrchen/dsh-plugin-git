# Contributing

English | [中文](CONTRIBUTING.zh.md)

Thanks for helping with `@dsh-electron/dsh-plugin-git` — the canonical source of the npm package that adds Git repository operations and Client UI to DeepSeek Harness as an out-of-tree bundle. Issues and pull requests are welcome.

## Before you start

These documents are the rules this repository enforces:

| Document | What it owns |
| --- | --- |
| [`AGENTS.md`](AGENTS.md) | Package boundary: standard DSH services only, `ctx.subprocess` with separate argv values, no shell interpolation, no Electron imports in the Host core, every portable Client contribution in the main fiber |
| [`docs/README.md`](docs/README.md) | The formal documentation library, its directories, and their boundaries |
| [`.agent/skills/documentation/SKILL.md`](.agent/skills/documentation/SKILL.md) | Documentation maintenance rules: bilingual pairs, ADRs, plan lifecycle, link and naming discipline |
| [`docs/development/README.md`](docs/development/README.md) | Toolchain, commands, build chain, and release process |

The package is pre-1.0: the API and versioning may change between minor releases. The Client half requires DeepSeek Harness ≥ v0.1.5-rc.2, because it registers its tab types through the upstream right sidebar.

## Environment

- Node.js `^22.19.0 || >=24.0.0` and pnpm 11 (`packageManager` pins the version);
- `git` on `PATH` — the Host service runs the real Git executable;
- a DeepSeek Harness runtime ≥ v0.1.5-rc.2 with the `dsh` CLI for manual verification of the Client half.

```sh
git clone https://github.com/cherrchen/dsh-plugin-git.git
cd dsh-plugin-git
pnpm install --frozen-lockfile
pnpm test
pnpm build
```

`prepare` is `pnpm run build`, so a GitHub/git install of this package builds itself on the installing machine: `tsc` emits the `lib/types/**` declarations, then `tsdown` bundles `lib/index.js` and `lib/client.js`. The `lib/` tree is not in Git — run `pnpm build` in your checkout, and again after editing sources; the artifact specs read it.

## Workflow

1. Branch off `main` (`fix/git-rpc-channel`, `feat/diff-tab`, `docs/installation`, …).
2. Keep the change surgical and do not reformat code you are not changing.
3. Commit in conventional-commit form with a scope, matching the existing history: `feat(client): …`, `fix(host): …`, `fix(git-graph): …`, `docs: …`, `test: …`, `chore(deps): …`.
4. Run the gates below; CI runs the same ones in the same order.

## Quality gates

`.github/workflows/ci.yml` runs `pnpm install --frozen-lockfile` and then these steps, in this order, for every pull request and every push to `main`:

| Command | What it proves |
| --- | --- |
| `pnpm test` | Host and Client specs: vitest, jsdom + `@testing-library/react` for components |
| `pnpm docs:check` | Documentation structure: bilingual pairs, link targets, file naming, forbidden absolute paths |
| `pnpm build` | The type declarations plus both bundle faces |
| `pnpm test:artifact` | The built Client bundle and the manifest it ships |
| `pnpm pack` | The tarball contains what `package.json` claims |

Tests read machine-readable Git output and use temporary repositories, so they need no network access and no model credentials.

## Documentation duty

Documentation is part of the change, not a follow-up:

- Edit the canonical document under `docs/` whenever the change touches requirements, architecture, a public interface, configuration, the workflow, build or release behavior, module boundaries, or troubleshooting knowledge; add a document only when none owns the fact;
- Keep every bilingual pair in sync within the same change (`README.md`/`README.zh.md`, `CONTRIBUTING.md`/`CONTRIBUTING.zh.md`, `CHANGELOG.md`/`CHANGELOG.zh.md`, `docs/*/README.md`/`README.en.md`), then re-record both blob hashes in the matching `*.i18n.yaml`:

  ```sh
  git hash-object README.md README.zh.md             # → README.i18n.yaml
  git hash-object CONTRIBUTING.md CONTRIBUTING.zh.md # → CONTRIBUTING.i18n.yaml
  git hash-object CHANGELOG.md CHANGELOG.zh.md       # → CHANGELOG.i18n.yaml
  ```

- Record a decision that had real alternatives and a lasting cost as an ADR under `docs/decisions/` (template: [`.agent/templates/adr.md`](.agent/templates/adr.md)), and move a finished plan from `docs/plans/active/` to `docs/plans/completed/`;
- Add the user-visible effect of your change under `## [Unreleased]` in [`CHANGELOG.md`](CHANGELOG.md) in the same pull request; the release commit moves it under the new version.

## Code rules

- Start Git through `ctx.subprocess` with an executable plus separate argv values; never build a command string, and keep every caller-supplied path, branch, and message as one argv value;
- The Host core depends only on standard DSH services: never import Electron, preload globals, or a Desktop provider into it;
- Keep every portable Client contribution in the main fiber; native enhancement belongs in a `ctx.inject(['desktop'], ...)` child fiber that declares only the structural methods it consumes;
- This package must stay independently installable and publishable: dependency ranges are registry semver, never `workspace:`;
- GitHub and remote-credential workflows stay outside this package until a separate decision adds them.

## Releases

Only maintainers cut releases. The process lives in [`docs/development/README.md`](docs/development/README.md#release-process): bump with `pnpm version:*`, commit, push a `vX.Y.Z` tag, and the release workflow publishes the tarball to npm and creates the matching GitHub Release.
