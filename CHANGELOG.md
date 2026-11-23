# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-11-23

### Added

- Feishu write tools can be previewed: every one takes `dryRun: true`, which
  returns the exact request it would have sent and makes no API call. The
  approval gate lets a dry run through, because nothing leaves the machine.
- `feishu_auth_status` now reports the granted scopes and every tool whose scope
  is missing, so a partially approved app shows up before the first failing
  call instead of as a 403.
- `feishu_api` reads any allowlisted `/open-apis/` GET path (bitable, okr,
  approval, attendance, …) as the connected user, covering the long tail without
  one tool per endpoint. Writes still require a dedicated tool.
- Task, calendar and minutes tools: `feishu_task_create`, `feishu_task_complete`,
  `feishu_task_list_mine`, `feishu_calendar_agenda` and `feishu_minutes_get`.
  The two task writes join the approval gate; the reads are read-only. Their four
  OAuth scopes (`task:task:write`, `task:task:read`, `calendar:calendar:read`,
  `minutes:minutes:readonly`) stay opt-in through `FEISHU_SCOPES`, so a tenant
  that only wants the document tools is not asked for them.

### Changed

- CI publishes without a stored token: `release.yml` now relies on trusted
  publishing (GitHub OIDC, `id-token: write`) and `docs/release.md` walks through
  the one-time configuration for all five packages, including the **npm publish**
  permission that new trust relationships no longer grant by default. A tag push
  no longer skips publishing when `NPM_TOKEN` is absent — a missing trust
  relationship fails the run instead of passing silently.

## [0.3.0] - 2026-11-23

### Changed

- Work mode is now a native DSH agent preset instead of a plugin toggle: the new
  session mode picker lists **工作模式 / Work mode** with a one-line description and
  the session attaches its WorkTask automatically, so the native header label is
  the only mode indicator. The `work` preset declares `name`, `description` and
  `order: 2.5`, placing it right after PTC.
- The composer context row now carries only the Feishu chip; the work-mode chip,
  the session-header 工作 button and the `+` menu 工作模式 command are gone (the
  built-in header-corner button and the 工作 tab still open the workbench).
- Work mode starts with a new session: DSH locks the agent preset after the first
  message, so an existing conversation can no longer be switched into work mode.
  A session that already carried the preset but never attached gets its draft
  task the first time it is opened; tasks created by an older version keep their
  state.

### Fixed

- Switching a still-blank session from the work preset back to another mode now
  releases the draft task the preset attached, so the Feishu chip, the work badge
  and the `[Work]` session title disappear with the mode. The auto-attach also no
  longer renames the session up front; the title is derived from the first
  message. Attached tasks record whether a preset or a person created them
  (`origin`), and only preset drafts are released automatically.
- The release also covers drafts attached by the older toggle, which carry no
  `origin`: the client and its tests now share one `shouldReleaseDraft`
  predicate, so a legacy placeholder is no longer kept alive by a stricter guard
  in the controller.

## [0.2.1] - 2026-11-20

### Fixed

- Documentation now matches the shipped behaviour: the Feishu surface exposes 15
  model-facing tools (not 14), screen reading works on Windows 10+ as well as
  macOS 13+, and the `accessTokenEnv` default is `FEISHU_USER_ACCESS_TOKEN`.
- Marketplace entry filename in `docs/release.md` follows the repository name
  (`silverze__dsh-work-plugin--packages-bundle.yml`), and the marketplace entry
  itself is documented there.
- `pnpm check:yaml` no longer fails on `profiles/work/dev.patch.yml.example`, a file
  that was never checked in (the real `dev.patch.yml` is generated and git-ignored);
  the check now runs in CI as well.
- The release workflow skips publishing when no `NPM_TOKEN` secret is set instead
  of failing the tag run: an unset secret arrives as an empty env value, so the
  old `if:` guard still ran the publish step and npm answered the anonymous
  request with 404.
- `scripts/install-work-profile.sh` installs the `@deepseek-ai/dsh-web-app` that
  matches the running runtime (installing rc.2 into rc.5 was rejected as
  incompatible) and points the bundle's `^<version>` dependencies at the packed
  tarballs through `overrides` in `pnpm-workspace.yaml`, so a source install no
  longer needs the version to be on the registry first.

## [0.2.0] - 2026-11-20

### Added

- `feishu_im_history`: read a chat's message history (group or direct) as the
  user, by chat name or chat_id, over a time window (`startTime`/`endTime`, or
  `recent: "7d"`). Feishu has no count endpoint and no offsets, so the window is
  the selector: each call returns a chunk of up to 1000 messages plus
  `nextEndTime` / `nextStartTime` to continue, `order` to pick which end to
  start from, and `stats` for per-day and per-sender counts without dumping the
  text. Needs a valid user token with the IM read scopes.
- Windows screen awareness: the Feishu conversation chip and the four screen
  tools now work on Windows 10+. A C# helper (`native/screen-ocr-win.cs`) is
  compiled once with the .NET Framework `csc` against the Windows SDK's
  `Windows.winmd`, and reads the window with
  `PrintWindow(PW_RENDERFULLCONTENT)` + the built-in `Windows.Media.Ocr` engine
  (~1.5 s per read, no permission prompt). Without the SDK it falls back to a
  PowerShell helper with the same output, about 2 s slower per read. The Swift
  and C# helpers share one command line and one JSON shape, so the parser is the
  same code on both platforms.

### Fixed

- Windows: the Feishu conversation is now read from the Chromium accessibility
  tree (`UI Automation`), which returns the exact message text; OCR is only the
  fallback when the tree is empty (a build with accessibility off, or a renamed
  client). Inline spans that Feishu splits a message into are joined back
  together, reaction tooltips are dropped, and container/image names no longer
  masquerade as the chat title.
- Windows: Feishu's translucent screen watermark no longer leaks into the
  quoted messages. Windows OCR reads the diagonal watermark tiles as many tiny
  lines, and a few of them always landed inside the conversation pane; the host
  now drops lines whose glyph height is far below the median height of real text
  (`dropWatermarkLines`), which follows window size and display scaling.
- Windows: the chat name now comes from the header title instead of the composer
  placeholder. The header renders the name larger, so OCR reads it more
  completely; the macOS ordering is unchanged.
- Windows: the contact's department and job title, which sit under the chat name,
  are no longer quoted as messages (the conversation starts below the title row).
- The Feishu conversation chip no longer shows up on a Host without screen
  awareness (Linux). The Host now reports the feature through a new
  `work/capabilities` remote method, and the client hides the chip and stops
  polling `work/presenceCapture` there; before, every click surfaced the raw
  English error "Feishu presence is disabled in this profile" and the chip kept
  failing in the background every 2.5 s.
- The `new_once` schedule test compares `artifactDir` with `path.join` instead of
  a hand-built POSIX path, so `pnpm test` passes on Windows.

## [0.1.2] - 2026-11-13

### Fixed

- The Feishu conversation chip now renders in the context row above the composer
  card, beside the work-mode toggle, instead of below the card: the row is
  registered on `conversation.input.dock` ("entries above the composer card")
  and sizes itself to the card's width, so both chips line up with its edges.
- `scripts/render-dev-patch.mjs` now inserts the client plugin, so a dev profile
  renders the work UI instead of loading no client code at all, and it creates
  `profiles/work` when the directory is missing.

## [0.1.1] - 2026-11-13

### Fixed

- The published bundle now depends on concrete `^0.1.0` ranges instead of the
  `workspace:^` protocol, which npm cannot install.

## [0.1.0] - 2026-11-13

### Added

- Work mode: attach a tracked work task to any session, with a task index in the
  session list and a workbench panel on the right.
- Workbench controller on the host: task creation, prompts, cancellation,
  scheduling, artifact indexing and export.
- Artifact library: task deliverables are indexed and openable from the panel.
- Scheduled work tasks with pause/resume, using the DSH schedule service.
- Feishu integration: OAuth loopback flow, OpenAPI client, and 14 model-facing
  tools for docs, sheets, wiki, IM and drive.
- Feishu conversation context (macOS): a composer chip that quotes the Feishu
  conversation currently on screen, with foreground following and a recent-chat
  fallback.
- Three chip appearances (DSH default, Codex, Claude) selectable in
  Settings → Feishu → Preferences.
- Seven bundled work skills: research, weekly report, meeting minutes, data
  analysis, presentation deck, document polish and screen awareness.

[Unreleased]: https://github.com/silverze/dsh-work-plugin/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/silverze/dsh-work-plugin/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/silverze/dsh-work-plugin/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/silverze/dsh-work-plugin/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/silverze/dsh-work-plugin/releases/tag/v0.2.0
[0.1.2]: https://github.com/silverze/dsh-work-plugin/releases/tag/v0.1.2
[0.1.1]: https://github.com/silverze/dsh-work-plugin/releases/tag/v0.1.1
[0.1.0]: https://github.com/silverze/dsh-work-plugin/releases/tag/v0.1.0
