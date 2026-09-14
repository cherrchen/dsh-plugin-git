[中文](README.md) | English

# development/ — Engineering practice

Holds **how this package is developed, tested, built, and released**: environment, workflow, testing conventions, build chain, and release process.

- Keep: toolchain versions, common commands, testing and fixture conventions, CI/CD notes, release process.
- Exclude: runtime behavior and configuration (→ root `README.md`), architecture design (→ [`../architecture/`](../architecture/README.md)), execution status of the release effort (→ [`../plans/active/`](../plans/active/README.md)).

## Quick entry

Toolchain: Node.js `^22.19.0 || >=24.0.0`, pnpm 11 (pinned via `packageManager`).

The `prepare` script is `pnpm run build` (tsc declarations plus both bundle faces): a git install of this package runs it on the installing machine. Inside a checkout, run `pnpm build` explicitly.

| Purpose | Command |
| --- | --- |
| Install (strict lockfile) | `pnpm install --frozen-lockfile` |
| Full test run | `pnpm test` |
| Build-artifact bundle/manifest assertions | `pnpm test:artifact` |
| Build (types + bundle) | `pnpm build` |
| Documentation machine check | `pnpm docs:check` |
| Set the version | `pnpm version:set <version>` (also accepts bump keywords such as `major`/`minor`/`patch`) |
| Bump the version | `pnpm version:major` / `pnpm version:minor` / `pnpm version:patch` |

CI runs in `.github/workflows/ci.yml` (tests on PRs and main pushes); the release pipeline is below, and its execution status lives in the [npm-first-release plan](../plans/active/npm-first-release.md). Contributor setup, the gate list, and the documentation duty are in [`CONTRIBUTING.md`](../../CONTRIBUTING.md).

## Release process

The version only changes through `pnpm version:*`: those scripts pass `--no-git-tag-version --no-git-checks`, so they **never** commit or tag on their own.

```sh
# 1. Move CHANGELOG.md's Unreleased entries under the new version, sync CHANGELOG.zh.md,
#    and re-record both hashes in CHANGELOG.i18n.yaml
pnpm version:minor   # or version:set <version> / version:major / version:patch
git add package.json CHANGELOG.md CHANGELOG.zh.md CHANGELOG.i18n.yaml
git commit -m "chore(release): 0.2.0"
git tag v0.2.0
git push origin HEAD --follow-tags
```

The release commit is also what moves the [`CHANGELOG.md`](../../CHANGELOG.md) entries out of `[Unreleased]` and points the `[Unreleased]` compare link at the new tag.

The tag must be `v` + the `package.json` version; otherwise the workflow stops at its first step. `.github/workflows/release.yml` is triggered by `v*` tag pushes and runs one sequential job:

1. Verify the tag matches the `package.json` version;
2. `pnpm install --frozen-lockfile` → `pnpm test` → `pnpm docs:check` → `pnpm build` → `pnpm test:artifact`;
3. `pnpm pack --pack-destination dist` produces the single tarball;
4. `npm publish <tarball> --access public --provenance` publishes to npm;
5. `gh release create --verify-tag --generate-notes` attaches that same tarball to the GitHub Release.

### npm auth: token for the first release, then OIDC

npm can only bind a Trusted Publisher once the package exists, so the first release uses a token and later ones use OIDC. A single workflow step picks one of the two automatically, based on whether the secret exists — no workflow change is needed to switch:

| Phase | Auth | Prerequisite |
| --- | --- | --- |
| First release | Repository secret `NPM_TOKEN` (Automation token with publish access) written into a temporary npmrc under `$RUNNER_TEMP` | The package does not exist on npm yet, so no Trusted Publisher can be bound |
| Afterwards | OIDC trusted publishing (`id-token: write`, no long-lived credential) | A Trusted Publisher bound to this package on npmjs.com (repository `cherrchen/dsh-plugin-git` + workflow filename `release.yml`), then delete `NPM_TOKEN` |

- The workflow installs npm `>=11.5.1` explicitly: the npm 10 that ships with Node 22.x does not support trusted publishing;
- Both modes pass `--provenance` (public repository + `id-token: write`), so published artifacts carry a verifiable source;
- The run log marks the mode actually used with `::notice title=npm auth::`;
- After a failure, re-run the workflow for that tag from the Actions UI; npm rejects republishing an existing version (E403), so shipped versions only move forward through a new version number.

Testing conventions: machine-readable Git output and temporary repositories; client specs use jsdom + `@testing-library/react`; the Graph layout fixtures and invariants are described in [`../reference/git-graph-layout.md`](../reference/git-graph-layout.md#测试与-invariants).
