# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-11-03

### Added

- `retireBundledRoute` option: after a sync, remove the bundled `opencode-go`
  provider route and move `agent-default-model` to the generated route that
  serves the same model. Only the untouched default profile is eligible, and
  retirement aborts when the default model is not in the live catalog.
- `status` now reports a `bundled` comparison: how many live models DSH's
  bundled snapshot is missing, which bundled models are no longer live, and
  whether the plugin has become redundant (`redundant: true`).
- Dry runs report the bundled route they would retire.

## [0.1.1] - 2026-11-03

### Fixed

- `retiredModels: keep` no longer resurrects models listed in `excludeModels`,
  and no longer duplicates a model that moved to another protocol route.
- A same-named provider using a different wire protocol is refused instead of
  overwritten, so a user-owned route can never be clobbered by a sync.
- Transient catalog failures (network errors, HTTP 429, HTTP 5xx) retry once
  with a short delay instead of failing until the next interval.
- A managed route whose protocol disappeared from the catalog is now removed
  automatically in `retiredModels: drop` mode.

### Changed

- Route planning moved to `lib/plan.js`, a dependency-free module covered by
  unit tests (21 total).

## [0.1.0] - 2026-11-03

### Added

- Host-only DSH bundle that syncs the live OpenCode Go catalog into three
  `llm-pi-ai` provider routes (`<prefix>-chat`, `<prefix>-anthropic`,
  `<prefix>-responses`).
- Catalog translation: context/output limits, image modalities, reasoning
  levels (`none` → `off`), per-protocol base URLs, and the required
  `x-opencode-session` header.
- Startup sync, periodic refresh, and the `opencode_model_sync` agent tool with
  `status`, `sync` (including `dryRun`), and `remove` actions.
- Idempotent writes: unchanged catalogs produce no settings update.
- `retiredModels: keep` option for retaining models that disappear upstream.
- Unit tests for the catalog translation (`npm test`).

### Fixed

- Deferred syncs now leave the HMR activation context, so startup refreshes are
  not rejected with "HMR transactions cannot be nested".
- Anthropic base URLs lose their trailing `/v1` because the pi-ai Anthropic SDK
  appends `/v1/messages` itself; without this the gateway answers 404.
