# DSH version compatibility

## `engines.dsh`

Every package declares:

```json
"dsh": ">=0.2.2-rc.2 <0.3.0"
```

Why these bounds:

- `>=0.2.2-rc.2` is the first DSH release this plugin was validated against.
- `<0.3.0` is the re-validation point: 0.x semver allows breaking changes in a
  minor release, and this plugin uses interfaces that are not covered by a
  stability promise (client slot names, `dsh.client.inject` service names, the
  `sessionController` / `schedule` / `credentials` / `tools` signatures, and the
  Typert remote descriptor format).

## Peer dependency ranges

Peer dependencies on `@deepseek-ai/*` are declared as:

```json
">=0.2.2-rc.2 <0.2.3-0 || >=0.2.3-0 <0.3.0"
```

The second segment exists because of the semver pre-release rule: a range only
accepts a pre-release when a comparator names the same `major.minor.patch` with a
pre-release tag. `>=0.2.2-rc.2 <0.3.0` alone rejects `0.2.3-rc.1`, which is exactly
how DSH publishes during its pre-release period.

`@deepseek-ai/cordis` stays at `~4.1.0`.

## What happens on a mismatch

DSH checks `engines.dsh` when a bundle is installed or enabled. On a mismatch you
get `incompatible-version` with the exact requirement, the plugin stays unloaded,
and DSH itself starts normally.

The real risk is a range that is too wide: writing `<1.0.0` would let the plugin
activate against a DSH that renamed a slot, failing silently at runtime instead of
being refused at install time.

## Checklist when DSH releases a new version

```bash
# 1. Record the version
dsh --version

# 2. Install into a throwaway profile and confirm the compatibility check passes
DSH_HOME=/tmp/probe dsh plugin --profile probe add ./packages/bundle

# 3. Boot it and confirm the plugins actually activate
DSH_HOME=/tmp/probe dsh --profile probe --no-open --port 3199
#    - the work-mode chip appears above the composer
#    - Settings has a "Feishu" section
#    - the session menu has a work-task entry

# 4. Unit tests and typecheck
pnpm test && pnpm -r typecheck
```

When everything passes, move the lower bound to the new version and keep the upper
bound at `<0.3.0` until the next minor is evaluated.
