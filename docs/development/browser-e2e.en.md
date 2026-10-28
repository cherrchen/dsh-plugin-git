[中文](browser-e2e.md) | English

# Isolated browser E2E

- **Status**: Current

## Running

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm test:e2e
```

Linux CI installs browsers with `pnpm exec playwright install --with-deps chromium`; the PR/main CI runs this suite. To use an existing local Chrome installation, run `DSH_E2E_BROWSER_CHANNEL=chrome pnpm test:e2e`. Playwright still uses a separate temporary user directory, never the everyday browser profile. On Windows, set the equivalent environment variable in your shell before running the tests.

Entry points are `playwright.config.ts` and `tests/e2e/auth.e2e.ts`. Playwright starts a dedicated Vite fixture server bound only to `127.0.0.1:4179`. An occupied port fails startup rather than reusing another service. Tests run serially, with an independent in-memory credential store and temporary Git repository for each scenario. Failure screenshots, traces and error context remain in `test-results/e2e/`; that directory and Playwright reports are ignored by Git.

Set `DSH_E2E_OUTPUT_DIR` to an absolute path outside the repository to keep failure screenshots and traces without overwriting working-tree test artifacts.

## Cross-platform CI acceptance

[Main CI](../../.github/workflows/ci.yml) runs the development pin on ubuntu-latest, windows-latest and macos-latest for PRs (including drafts) and main pushes, without cancelling other systems after one fails. Each lane performs frozen installation, compatibility checks, the full unit suite, A1/A2/A3 acceptance probes, Chromium E2E, documentation checks, build, artifact checks and pack. Git fixtures disable autocrlf consistently. Command-error classification uses an actual Git repository with a malformed config rather than a POSIX shell. Browsers use list and HTML reporters; per-system reports and failure traces are retained for 14 days.

Path assertions compare filesystem identity rather than Git separators or Windows temporary-directory short names. The RPC test adapter resolves Git using case-insensitive Windows environment keys and `PATHEXT`. Real filenames use characters allowed on every system; a synthetic patch separately verifies double-quoted display paths. Production path identity is defined in the [architecture overview](../architecture/overview.en.md).

The other 17 exact DSH releases remain covered by the [compatibility matrix](../../.github/workflows/upgrade.yml) on Ubuntu. OS and release matrices are separate, not the full release × OS product. Associate CI results with the current PR head; queued/running checks are not passes. Automation covers portable Host/Git and browser Client fixtures. Real accounts, Self-Managed GitLab, full DSH Web/Desktop startup and native enhancement unload still require independent environment evidence in the [remote-platform plan](../plans/active/remote-platform-integration.en.md).

## Isolation and validation boundaries

The browser runs the repository's actual `RemoteAuthControl` / `RemoteAuthSection`, Client controller and capability store. A loopback HTTP adapter calls the real `GitRemoteRuntime`, authentication engine and GitHub/GitLab providers. Repository reads execute real Git using temporary HOME / USERPROFILE / XDG_CONFIG_HOME / GH_CONFIG_DIR values and isolated global/system Git configuration. User helper settings and token environment variables are never read.

Deterministic fixtures replace external GitHub OAuth/REST and GitLab API services and gh/credential-helper probes, issuing only synthetic sentinel tokens. The backend intercepts outbound requests; the browser rejects non-loopback requests. Tests never contact real GitHub, alter existing user grants, open real authorization pages or send writes to real remotes. Fixture control endpoints are registered only by the test Vite configuration and are excluded from the published package. Server shutdown cancels runtime work and removes temporary repositories.

The browser cases cover:

- Chinese/English labels for gh, OAuth and credential references;
- Disconnecting and reconnecting GitHub CLI through the method radios (the signed-out marker is cleared first inside the same run), plus a dialog-width assertion and screenshots;
- The complete internal anonymous-to-OAuth device-login flow and cancellation;
- Absence of token bodies from browser RPC responses and page content;
- Authentication isolation between separate browser contexts and credential stores;
- GitLab instance prefixes, MR reads, comments, reconciliation after an unknown approval, limited notices and simulated local-push suggestions.

Missing/unknown sources and invalid authentication states are covered separately by `tests/remote-auth-section.client.spec.tsx`. The regression for authentication changes overlapping an older capability read lives in `tests/remote-client.spec.ts`.

These are browser-to-plugin-runtime E2E tests with substituted external service boundaries. They do not replace real GitHub OAuth/SSO, system credential-helper compatibility or complete DSH Host integration acceptance. Real-service acceptance remains tracked in the [remote-platform plan](../plans/active/remote-platform-integration.en.md); source semantics belong to the [remote-platform RPC contract](../reference/remote-platform-rpc.en.md).
