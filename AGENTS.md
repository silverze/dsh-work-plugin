# AGENTS.md

How to change this repository safely. `CONTRIBUTING.md` covers setup, tool/skill recipes and the
release ritual; this file is the short list of things an agent gets wrong, and the rules that
are not obvious from the code.

## Repository map

```text
packages/bundle        the published bundle: cordis.patch.yml, presets/work.patch.yml,
                       locale/{en,zh}.json, docs that ship in the tarball
packages/host-work     work tasks, artifacts, schedules, presence tools
packages/host-feishu   Feishu OAuth, OpenAPI client, model tools, approval gate
packages/client-work   web client plugins: workbench panel, composer chip, settings
packages/skills-work   bundled SKILL.md skills
tests/unit             node:test suites, run against the built packages
```

## Commands

```bash
pnpm build            # tsdown per package
pnpm -r typecheck     # tsc --noEmit, strict
pnpm test             # builds host/client/feishu, then node --test tests/unit/*.test.mjs
pnpm check:public     # PII / secret / packaging guard (see below)
pnpm docs:check       # docs links + counts
pnpm check:yaml       # parses every .yml under packages/
pnpm publish:dry      # pack + inspect before a release
```

## Code rules

- TypeScript strict. No `any` unless unavoidable, and then say why in a comment.
- Host packages must stay free of React and browser APIs; client packages must stay free of Node
  built-ins. The split is what lets the client bundle run in the webview.
- Comments explain *why*. Delete dead code instead of commenting it out.
- Match the existing style: single quotes, no semicolons, two-space indent.
- Tool schemas are plain JSON-Schema objects passed to `defineTool({ parameters, output })`. `zod`
  is only for storage records (`packages/host-work/src/domain.ts`).

## DSH plugin rules that fail silently

- `inject` must list **every** Cordis service the plugin touches. Calling `ctx.get('sessions')`
  without `'sessions'` in `inject` yields a permanent no-op: the feature looks installed and does
  nothing. When a service is genuinely optional, read it through `ctx.get` and degrade visibly
  instead of silently.
- Register tools with `ctx.tools.register(defineTool({ name, description, parameters, output, execute }))`.
  `output.schema` must set `additionalProperties: false`; `output.render` returns `ContentBlock[]`.
- A tool description is product surface: what it does, when to use it, what it costs, and for
  outward writes "confirm with the user first". Write tools that support previewing say so.
- **Feishu write tools**: add the name to `FEISHU_WRITE_TOOLS` in `packages/host-feishu/src/approval.ts`
  **and** implement the `dryRun` branch. The gate deliberately trusts
  `exec.arguments.dryRun === true` and skips approval, so a write tool without a working dryRun
  branch can run unapproved.
- User-visible strings live in `packages/bundle/locale/en.json` and `zh.json` — keep both in sync.
- A mode/preset change means `packages/bundle/presets/work.patch.yml`, the `docs/compat.md`
  checklist, and a CHANGELOG entry; a preset is user data, not an implementation detail.

## Tests

- `node:test` only, one file per subject under `tests/unit/`. Suites import the built output
  (`../../packages/<pkg>/lib/index.js`), which is why `pnpm test` builds first.
- Fake clients are duck-typed objects; assert the request payloads (method, path, query, body),
  not the SDK's internals.
- Fixtures must be obviously fictional — see the private-data section. Never paste a live payload
  into a test and generalise it later.

## Docs that move together

| Change | Also update |
| --- | --- |
| user-visible behaviour | `README.md`, `README.zh.md` |
| anything shipped to npm | `CHANGELOG.md` under `## [Unreleased]` |
| a component, tool count, or data flow | `docs/architecture.md` |
| what users install | `packages/bundle/docs/DETAIL.md`, `DETAIL.zh.md` (they ship in the tarball) |
| a tool needing a new scope | `docs/feishu-app-setup.md` scope table |
| DSH compatibility | `docs/compat.md` |

## Versions and releases

- The five published packages move in lockstep: same version everywhere, plus the CHANGELOG
  heading. `@dsh-work-plugin/bundle` depends on the others with `workspace:^`.
- `workspace:^` is rewritten only by `pnpm publish`. Never `npm publish` inside a package.
- Publish order: skills → feishu → host → client → bundle, via `pnpm release:publish`, which pins
  `--registry=https://registry.npmjs.org/` (the local `~/.npmrc` may point at a mirror) and adds
  `--provenance` only when `GITHUB_ACTIONS=true`.
- Tagging `v<version>` runs `.github/workflows/release.yml` with trusted publishing (GitHub OIDC,
  `id-token: write`). Do not reintroduce `NODE_AUTH_TOKEN`; do not pass `--provenance` locally.
- `engines.dsh` is a compatibility window. Widening it requires a pass over `docs/compat.md`.

## Private data and secrets

Code, tests, comments, fixtures, docs, commit messages and screenshots are public.

- Never include real person names, avatars, open_ids, employee IDs, emails, phone numbers, chat
  group names or chat_ids, message text, company/department/customer/tenant names, tenant keys,
  Feishu App IDs or secrets, OAuth codes, tokens, or real task/calendar/document titles.
- Use obviously fictional values: `张三` / `李四` / `王五` (`Alice` / `Bob` in English fixtures),
  `示例产品群` / `Example group`, `ou_xxx` / `cli_xxx` / `docx_example`, dates that cannot collide
  with real records.
- `pnpm check:public` rejects emails, phone numbers, absolute home paths, `sk-` keys, `cli_` app
  IDs, `app_secret=…`, bearer tokens and private keys, and checks packaging. Site-specific names
  deliberately are not in the script — the script is public; keep them in the git-ignored
  `scripts/public-denylist.local.txt`, one case-insensitive regex per line.
- The guard reads `git ls-files`: a new file is invisible until staged. `git add` first, then check.
- Screenshots in `assets/` ship in the README. Regenerate them from a throwaway profile
  (`DSH_HOME=/tmp/...`) with a fictional workspace, never from a signed-in real tenant, and check
  the result for real names, avatars, group titles and tenant logos before committing.
- App secrets go through `FEISHU_APP_SECRET` or `ctx.credentials`. `.env.example` holds
  placeholders only.

## Environment gotchas

- `ps` may be unavailable in the sandbox; find a process with `lsof -ti tcp:<port>` instead.
- pnpm sometimes prints `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` before running a script (it
  wants to move the store). The script still runs; that warning is not the failure.
- `profiles/`, `packages/*/lib/`, `tests/.artifacts/` and `.pnpm-store/` are ignored on purpose:
  generated output and machine-specific patch files never enter the repo.
- After changing `host-work`/`host-feishu`, a profile must reinstall the bundle and restart DSH;
  client-only changes are picked up by refreshing the web page.

## Before you commit

```bash
pnpm build && pnpm -r typecheck && pnpm test
pnpm check:public && pnpm docs:check && pnpm check:yaml
git status --short      # only the files you meant to change
```
