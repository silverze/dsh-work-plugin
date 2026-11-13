# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/silverze/dsh-work-plugin/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/silverze/dsh-work-plugin/releases/tag/v0.1.0
