# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
