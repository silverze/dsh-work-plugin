# ADR-0001: build on DeepSeek Harness instead of forking it

- Status: accepted
- Date: 2026-11-09

## Context

The goal is a work layer for DeepSeek Harness (DSH): tracked work tasks, Feishu
docs and sheets, Office deliverables, schedules, sharing, and a workbench UI.

DSH 0.2.2-rc.2 already provides the hard parts: agent loop, session persistence,
tools, skills, subagents, jobs, schedules, Office skills, document preview,
credentials, authorization, the web client plugin system, the `main` panel slot,
`storageDomain`, MCP, OpenTelemetry, and token metering.

The remaining question is where the work layer lives: inside a fork of DSH, or as
plugins installed into an unmodified DSH.

## Decision

**Do not fork the DSH kernel.** Ship a separate repository with:

1. `@dsh-work-plugin/bundle` — a bundle (profile patch layer) that composes the rest.
2. `@dsh-work-plugin/host` / `@dsh-work-plugin/feishu` — host plugins (services and model tools).
3. `@dsh-work-plugin/client` — web client plugins (`dsh.client`, React 18).
4. `@dsh-work-plugin/skills` — a bundled skill provider.
5. A `work` agent preset delivered by the bundle.

If a capability genuinely requires changing session events, permission hooks, or
the agent loop, send a pull request upstream instead of maintaining a local patch
tree.

## Rationale

- Cordis plugin registrations are effect-based, so unloading the bundle cleans up
  every row it installed — a product layer can evolve without forking.
- Reusing sessions, sandboxing, approvals, scheduling and preview is the only way
  this scope stays maintainable.
- Upstream upgrades reduce to adapting the plugin layer; a fork would turn
  pre-release churn into permanent maintenance.
- Client plugins can register a top-level panel and reuse chat, preview and
  settings, so the UX does not require rewriting the web shell.

## Consequences

**Positive**: fast delivery, low upgrade cost, a clear capability boundary, and
the DSH permission and sandbox model applies unchanged.

**Negative**:

- Compatibility is tied to DSH pre-releases; `engines.dsh` pins
  `>=0.2.2-rc.2 <0.3.0` and each DSH minor needs re-validation.
- `dsh.client.inject` service names and slot names are internal interfaces; CI
  fixes the DSH version and runs the unit suite against it.
- Some deep UI surfaces cannot be reached from a plugin; those need a separate
  design rather than a fork.

## Alternatives considered

| Option | Verdict |
| --- | --- |
| Fork DSH and edit its packages | Rejected: pre-release churn, high maintenance, loses upstream work |
| Own agent kernel, borrow only DSH tools | Rejected: reimplements sessions, sandbox, approvals, scheduling |
| Standalone web app on a DSH SDK | Deferred: more freedom, but rewrites chat, preview and settings |
| Feishu connector only, no workbench | Rejected: cannot carry the task → artifacts → schedule loop |
