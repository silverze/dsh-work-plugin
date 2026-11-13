# Release and upgrade

Five packages ship together at the same version:

| Package | Role |
| --- | --- |
| `@dsh-work-plug/skills` | bundled skill provider |
| `@dsh-work-plug/feishu` | Feishu OAuth, OpenAPI client, tools |
| `@dsh-work-plug/host` | work tasks, artifacts, schedules, presence tools |
| `@dsh-work-plug/client` | web client plugins (workbench, chip, settings) |
| `@dsh-work-plug/bundle` | patch + preset + locale, depends on the four above |

## Version policy

- All five packages share one version. Bump them together; the bundle depends on the
  others with `workspace:^`, which pnpm rewrites to `^<version>` on publish.
- `engines.dsh` on the bundle is `>=0.2.2-rc.2 <0.3.0`. Peer ranges on
  `@deepseek-ai/*` also include the pre-release line — see [compat.md](compat.md).
- Release candidates use `0.1.0-rc.N`; publish `0.1.0` once the profile smoke test passes.

## Pre-flight

```bash
pnpm install
pnpm build
pnpm -r typecheck
pnpm test
pnpm check:public
pnpm docs:check
```

`pnpm check:public` fails on internal identifiers, secrets, `file:` dependencies,
absolute home paths, a missing `LICENSE`, or a repository field that does not point
at `github.com/silverze/dsh-work-plug`.

## Publish to npm

Order matters: the bundle resolves its dependencies from the registry.

```bash
pnpm -C packages/skills-work publish --access public
pnpm -C packages/host-feishu publish --access public
pnpm -C packages/host-work publish --access public
pnpm -C packages/client-work publish --access public
pnpm -C packages/bundle publish --access public
```

Or push a `v*` tag and let `.github/workflows/release.yml` publish all five with
provenance (`id-token: write`, `NPM_TOKEN` secret).

Verify:

```bash
npm view @dsh-work-plug/bundle version dependencies repository
mkdir -p /tmp/install-check && cd /tmp/install-check
npm i @dsh-work-plug/bundle --dry-run
```

## Install and upgrade

```bash
dsh plugin add @dsh-work-plug/bundle      # install
dsh plugin add @dsh-work-plug/bundle@0.1.1  # upgrade to a specific version
```

Restart DeepSeek Harness after installing or upgrading: host plugins load at boot.
The web client bundle reloads on page refresh.

## Marketplace listing

The plugin is listed through
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin):
one YAML entry at `data/plugins/silverze__dsh-work--packages-bundle.yml`, pointing at
`https://github.com/silverze/dsh-work-plug/tree/main/packages/bundle`. The marketplace
index (`dsh-plugin-catalog`) is generated from that repository, so a version change
needs no new entry — only a release.

## Checklist

- [ ] Five package versions identical
- [ ] `pnpm test`, `pnpm -r typecheck`, `pnpm check:public`, `pnpm docs:check` pass
- [ ] `pnpm pack` tarballs contain no tests, docs status files or secrets
- [ ] Clean `DSH_HOME` install + boot, work mode visible
- [ ] No token, secret, real chat name or order number in the repository
- [ ] `CHANGELOG.md` updated and tagged
