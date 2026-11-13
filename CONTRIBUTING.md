# Contributing to DSH Work

Thanks for taking the time to contribute. This repository is a pnpm monorepo with five packages; the bundle package wires the others into a DeepSeek Harness profile.

## Requirements

- Node.js >= 24
- pnpm 11.28.5 (`corepack enable` picks the pinned version)
- DeepSeek Harness >= 0.2.2-rc.2 for manual testing
- macOS only for the screen/Feishu awareness parts; the rest builds and tests on Linux

## Setup

```bash
pnpm install
pnpm build
pnpm test        # builds host/client/feishu, then runs node --test tests/unit/*.test.mjs
pnpm -r typecheck
```

Load your local build into a throwaway profile:

```bash
dsh plugin add ./packages/bundle
dsh web
```

Restart the app after changing `packages/host-work` or `packages/host-feishu`; the web client bundle hot-reloads on refresh.

## Repository layout

```text
packages/bundle        the published bundle: patch + preset + locale + icon
packages/host-work     host services: work tasks, artifacts, schedule, presence tools
packages/host-feishu   Feishu OAuth, OpenAPI client, model tools
packages/client-work   web client plugins: workbench panel, composer chip, settings
packages/skills-work   bundled work skills (research, weekly report, ...)
tests/unit             node:test suites that run against the built packages
docs                   architecture, compatibility, release notes
```

## Adding a tool

1. Define it in the owning host package (`packages/host-work/src/tools.ts` or `packages/host-feishu/src/...`) with a zod schema and a short model-facing description.
2. If the client needs it, add a remote method in `work-remote.ts` and include the name in the `remote-methods` list at the bottom of that file.
3. Add a unit test. Tool descriptions are product surface: say what the tool does, when to use it, and its cost.

## Adding a skill

1. Create `packages/skills-work/skills/<name>/SKILL.md` with `name` and `description` frontmatter.
2. Keep the body procedural: steps, commands, failure modes.
3. Run `pnpm test`; the skills provider test asserts the bundled skill list.

## Code expectations

- TypeScript strict mode; no `any` unless unavoidable and commented.
- Keep host packages free of React and browser APIs; keep client packages free of Node APIs.
- Comments explain why, not what. Delete dead code instead of commenting it out.
- Tests must not contain real names, group names, order numbers, hostnames, or tokens. Use obviously fictional fixtures (`示例产品群`, `DEMO-8891`).

## Pull requests

- One logical change per PR, with a short "what changed / why" body.
- `pnpm build && pnpm -r typecheck && pnpm test && pnpm check:public && pnpm docs:check` must pass.
- Update `README.md` and `README.zh.md` when user-visible behavior changes.
- Update `CHANGELOG.md` under `Unreleased`.

## Reporting bugs

Use the bug report template and include: DSH version, OS version, the failing tool or panel, and the exact error text. Do not paste real chat content; redact names and ids.

By contributing you agree that your contributions are licensed under the MIT license in `LICENSE`.
