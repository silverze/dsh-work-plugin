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
pnpm check:yaml
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

Or push a `v*` tag and let `.github/workflows/release.yml` publish all five
without a stored token, using trusted publishing — configure it once, see
[Tokenless CI releases](#tokenless-ci-releases-trusted-publishing).

Verify:

```bash
npm view @dsh-work-plugin/bundle version dependencies repository
mkdir -p /tmp/install-check && cd /tmp/install-check
npm i @dsh-work-plugin/bundle --dry-run
```

## Tokenless CI releases (trusted publishing)

A tag push publishes through GitHub Actions, which proves *which repository and
which workflow* is asking. npm exchanges that GitHub OIDC token for a credential
that is valid for one publish, so no `NPM_TOKEN` secret exists to leak, rotate or
leave behind. The same publish carries a provenance attestation.

This is the recommended path, not only a security nicety: npm now treats a
granular token with **Bypass 2FA** as a restricted credential — direct publishes
and account changes may be refused with `403 ... Granular access tokens that
bypass two-factor authentication may not perform this action` — and a publish can
be quietly turned into a staged release that needs a person to approve it. The
0.3.0 release went through exactly that. OIDC publishes do not.

### Before you start

- Two-factor authentication enabled on the npm account that owns the packages.
- The five packages already exist on the registry (first publish has to happen
  with a token; trusted publishing cannot create a package).
- `npm` 11.15.0 or later if you use the CLI route below. This machine's npm is
  11.6.2, so run the commands through `npx --yes npm@11.21.3`.
- The workflow runs on a GitHub-hosted runner (`ubuntu-latest`). Trusted
  publishing does not accept self-hosted runners.

### Configure the five trust relationships in the web UI

There is no organisation-wide switch: each package needs its own relationship.

1. Sign in on npmjs.com as `silverze`.
2. Open the package, e.g.
   <https://www.npmjs.com/package/@dsh-work-plugin/skills>, and click **Settings**
   in the package header (not the account settings page).
3. Find **Trusted Publisher** → **Add trusted publisher** → **GitHub Actions**.
4. Fill in exactly:

   | Field | Value |
   | --- | --- |
   | Organization or user | `silverze` |
   | Repository | `dsh-work-plugin` |
   | Workflow filename | `release.yml` |
   | Environment name | leave empty |

   The workflow filename is a filename only — no path, but it must keep the
   `.yml` extension and the file must live in `.github/workflows/`. The
   environment has to match the job: `release.yml` sets none, so leaving it empty
   is required.

5. Under **Allowed actions**, tick **npm publish**. Connections created after
   2026-09-03 allow *staged* publishing only by default; our workflow publishes
   directly, and without this tick the registry rejects it.
6. **Add trusted publisher**, then repeat steps 2–5 for `feishu`, `host`,
   `client` and `bundle`.

### Configure the five trust relationships from the CLI

Same effect, no clicking through five package pages, but the commands need an
interactive 2FA confirmation — a bypass-2FA granular token is refused by the
`npm trust` endpoints, so a CI secret cannot do this for you.

```bash
for p in skills feishu host client bundle; do
  npx --yes npm@11.21.3 trust github "@dsh-work-plugin/$p" \
    --repo silverze/dsh-work-plugin --file release.yml --allow-publish --yes
  sleep 2
done

npx --yes npm@11.21.3 trust list @dsh-work-plugin/skills   # shows the ID and claims
```

Facts worth knowing before re-running anything:

- `--allow-publish` is the flag that permits a direct `npm publish`;
  `--allow-stage-publish` only permits `npm stage publish`.
- Omit `--env` unless the workflow declares `environment:` with the same name.
- `npm trust` writes one relationship per package; a second `npm trust github`
  against an already-configured package fails. To change it:
  `npm trust revoke --id <id> <package>`, then create the new one.
- `npm trust list <package>` is the quickest way to confirm what is configured
  and to copy the ID for a revoke.

### What the workflow does

`release.yml` already requests `id-token: write`, which is the one hard
requirement; everything else is pnpm's job:

- The publish step runs `scripts/release-publish.mjs`, which calls
  `pnpm publish --registry=https://registry.npmjs.org`. pnpm exchanges the GitHub
  OIDC token itself; the 11.28.5 pinned here also contains pnpm's 11.1.3 fix,
  which ignores the empty `_authToken=${NODE_AUTH_TOKEN}` line that
  `actions/setup-node` writes when `registry-url` is set and no token exists.
- No `NODE_AUTH_TOKEN` is set in the job. Do not add one "to be safe": an empty
  token breaks the exchange, and a real token is exactly what this setup removes.
- `--provenance` is passed only when `GITHUB_ACTIONS=true`; on a laptop that flag
  fails with `Automatic provenance generation not supported for provider: null`.
- The step is not skipped when no secret is present any more. Publishing a tag
  before the trust relationships exist now fails the run instead of staying green
  and doing nothing — that failure is the signal to go back to this page.

### Verify on the next release

1. Bump the five versions and `CHANGELOG.md`, commit, then
   `git tag -a vX.Y.Z -m ...` and push the tag.
2. Watch the **Release** run: the publish step prints
   `publish @dsh-work-plugin/skills@X.Y.Z` followed by
   `📦 @dsh-work-plugin/skills@X.Y.Z → https://registry.npmjs.org/`, five times.
3. Open the package page: each version shows **Built and signed on GitHub
   Actions** under the version list (the provenance badge).
4. After the first green run, delete the old secret under
   *Repo → Settings → Secrets and variables → Actions → NPM_TOKEN*. The local
   token can stay for emergency laptop releases.

### When it fails

| Symptom | Cause |
| --- | --- |
| `403` / "not authorized to publish this package" | Workflow filename, repository or environment does not match the trust relationship, or **npm publish** was not ticked under Allowed actions |
| `EOTP` or the bypass-2FA message in CI | A `NODE_AUTH_TOKEN` is still set in the job or the repo secret is being injected |
| `npm trust` refuses with a 2FA error | Account 2FA is off, or the token in `~/.npmrc` is a bypass-2FA granular token — log in interactively |
| Publish step skipped, run green | An older `release.yml` with the `if [ -z "$NODE_AUTH_TOKEN" ]` guard is still on the tag |
| `EUSAGE Automatic provenance generation not supported for provider: null` | `--provenance` reached a laptop publish; only the CI path should pass it |

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
one YAML entry at `data/plugins/silverze__dsh-work-plugin--packages-bundle.yml`, pointing at
`https://github.com/silverze/dsh-work-plugin/tree/main/packages/bundle`. The marketplace
index (`dsh-plugin-catalog`) is generated from that repository, so a version change
needs no new entry — only a release.

The first entry is
[PR #17172](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/17172) on the
upstream repository; once it merges, the storefront picks the plugin up on the next
catalogue build.

The entry is a single file, opened as a pull request against
`awesome-dsh-plugin/awesome-dsh-plugin`. Keep it to one entry per PR (the repo caps a
PR at three) and do not edit the generated README files:

```yaml
url: https://github.com/silverze/dsh-work-plugin/tree/main/packages/bundle
name: silverze/dsh-work-plugin#packages/bundle
category: workflow
icon: https://raw.githubusercontent.com/silverze/dsh-work-plugin/main/assets/icon-180.png
description:
  en: 'Work mode for a DeepSeek Harness session: a stated goal becomes a tracked work task that keeps its plan, an artifact library indexed by size, hash and version, and RRULE schedules the host reruns after the conversation ends, with results handed to Feishu docs, sheets, wiki, drive and IM. Ships the work agent preset, a right-sidebar workbench for the current task, artifacts and schedules, 14 work tools, 15 Feishu tools, seven work skills, and on macOS 13+ and Windows 10+ a composer chip that quotes the Feishu conversation on screen.'
  zh: '给 DeepSeek Harness 会话加上工作模式：一句话目标变成可跟踪的工作任务，任务在对话结束后仍保留计划、按大小/哈希/版本索引的成果库与由宿主触发的 RRULE 定时，结果可交回飞书云文档、表格、知识库、云空间与消息。附带 work Agent 预设、右侧工作台（当前任务/成果库/定时）、14 个 work 工具、15 个飞书工具、七个工作技能，以及 macOS 13+ 与 Windows 10+ 上把屏幕上正在看的飞书会话一键引用进输入框的 chip。'
```

Every number in that description is checkable in the packages: 14 `work_*` tools in
`packages/host-work`, 15 `feishu_*` tools in `packages/host-feishu`, seven skills in
`packages/skills-work/skills`. Update the entry text whenever those counts change.

## Checklist

- [ ] Five package versions identical
- [ ] `pnpm test`, `pnpm -r typecheck`, `pnpm check:public`, `pnpm docs:check`, `pnpm check:yaml` pass
- [ ] `pnpm pack` tarballs contain no tests, docs status files or secrets
- [ ] Clean `DSH_HOME` install + boot, work mode visible
- [ ] No token, secret, real chat name or order number in the repository
- [ ] `CHANGELOG.md` updated and tagged
- [ ] Trusted publisher configured for all five packages, so the tag push needs no `NPM_TOKEN`
