# Release and upgrade

Five packages ship together at the same version:

| Package | Role |
| --- | --- |
| `@dsh-work-plugin/skills` | bundled skill provider |
| `@dsh-work-plugin/feishu` | Feishu OAuth, OpenAPI client, tools |
| `@dsh-work-plugin/host` | work tasks, artifacts, schedules, presence tools |
| `@dsh-work-plugin/client` | web client plugins (workbench, chip, settings) |
| `@dsh-work-plugin/bundle` | patch + preset + locale, depends on the four above |

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
at `github.com/silverze/dsh-work-plugin`.

## Publish to npm

Order matters: the bundle resolves its dependencies from the registry, so the
script publishes skills → feishu → host → client → bundle. Versions that are
already on the registry are skipped, which makes a re-run (or a moved tag)
safe.

```bash
pnpm run release:publish          # add --dry-run to only print the plan
```

Always publish with **pnpm**, never with `npm publish`: pnpm rewrites the
`workspace:^` protocols in `packages/bundle/package.json` into concrete
`^<version>` ranges, while `npm publish` ships them verbatim and every install
fails with `EUNSUPPORTEDPROTOCOL Unsupported URL Type "workspace:"`.

Or push a `v*` tag and let `.github/workflows/release.yml` publish all five with
provenance (`id-token: write`, `NPM_TOKEN` secret). Without that secret the job
stays green and skips publishing; the other option is to configure a trusted
publisher for each `@dsh-work-plugin/*` package on npmjs.com
(Package settings → Trusted publishing → GitHub Actions, workflow
`release.yml`), after which no token is needed.

Verify:

```bash
npm view @dsh-work-plugin/bundle version dependencies repository
mkdir -p /tmp/install-check && cd /tmp/install-check
npm i @dsh-work-plugin/bundle --dry-run
```

## Install and upgrade

```bash
dsh plugin add @dsh-work-plugin/bundle      # install
dsh plugin add @dsh-work-plugin/bundle@0.1.1  # upgrade to a specific version
```

Restart DeepSeek Harness after installing or upgrading: host plugins load at boot.
The web client bundle reloads on page refresh.

## Marketplace listing

The plugin is listed through
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin):
one YAML entry at `data/plugins/silverze__dsh-work--packages-bundle.yml`, pointing at
`https://github.com/silverze/dsh-work-plugin/tree/main/packages/bundle`. The marketplace
index (`dsh-plugin-catalog`) is generated from that repository, so a version change
needs no new entry — only a release.

## Checklist

- [ ] Five package versions identical
- [ ] `pnpm test`, `pnpm -r typecheck`, `pnpm check:public`, `pnpm docs:check` pass
- [ ] `pnpm pack` tarballs contain no tests, docs status files or secrets
- [ ] Clean `DSH_HOME` install + boot, work mode visible
- [ ] No token, secret, real chat name or order number in the repository
- [ ] `CHANGELOG.md` updated and tagged
