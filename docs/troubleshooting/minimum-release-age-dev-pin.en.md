[中文](minimum-release-age-dev-pin.md) | English

# Main CI frozen install rejects the development pin under `minimumReleaseAge`

## Symptom

- The `verify` job in `.github/workflows/ci.yml` fails at `pnpm install --frozen-lockfile`, after roughly ten seconds.
- The log is `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`. Every entry is an `@deepseek-ai/dsh-*@<development pin>` already committed in the lockfile, published inside the 24-hour cooldown window.
- Matrix lanes in `.github/workflows/upgrade.yml` still pass (that job sets `pnpm_config_minimum_release_age=0`).

## Root cause

Main CI keeps pnpm 11's default 24-hour release-age cooldown and checks entries in the **committed lockfile**, not only newly resolved packages. After the development pin moves to a prerelease that just published, that release's transitive DSH packages are younger than one day and the frozen install is rejected. This is separate from "do not write unpromised or mixed prereleases into the exclude list": the latter stops the lockfile from drifting to versions outside the support list; the former lets main CI install the reviewed development pin.

The contract is the [DSH compatibility contract](../reference/dsh-compatibility.md) and [ADR-0003](../decisions/ADR-0003-dsh-compatibility-contract.md).

## Fix (verified)

Write every `@deepseek-ai/dsh-*@<pin>` of the **current development pin** from the `packages` section of `pnpm-lock.yaml` into `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`, and **replace the whole list**. Do not append the new pin after the old pin.

pnpm 11.7 honors only the first `name@version` rule for a given package name ([pnpm#12463](https://github.com/pnpm/pnpm/issues/12463)). Entries for the old pin keep same-named packages of the new pin under the 24-hour cooldown. If several versions must be kept, write one `name@a || b` row instead of two lines. Do not:

- set `pnpm_config_minimum_release_age` to `0` in `.github/workflows/ci.yml`;
- write a range exemption such as `@deepseek-ai/*`;
- put a version that is not on the support list, or that is not the current pin, into the exclude list.

Verification: the same `pnpm install --frozen-lockfile` passes while the default cooldown stays on, and `pnpm compat:check` still accepts only the pin versions in the lockfile. The next time the development pin changes, if the new pin is still younger than 24 hours, **replace** this exact list with the new pin.
