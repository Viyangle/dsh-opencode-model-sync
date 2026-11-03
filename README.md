# DSH OpenCode Model Sync

Keep the DSH model picker in sync with the **live** OpenCode Go model catalog.

DSH ships its provider catalog as a build-time snapshot. When OpenCode publishes
a new model — say `kimi-k3.1-pro` — the model exists on the endpoint but the
picker does not list it until a new DSH build ships. This plugin closes that gap:
it fetches the catalog from `opencode.ai` and writes the result into the
`llm-pi-ai` settings section, so new models appear after a sync instead of after
a release.

- No DSH rebuild, no `app.asar` patching, no custom protocol code.
- Startup sync, periodic refresh, and a manual agent tool.
- Writes only the three provider routes it owns; every other provider and
  credential is left untouched.
- Idempotent: an unchanged catalog produces no settings write.

[中文说明](README.zh.md)

## Requirements

| Requirement | Notes |
| --- | --- |
| DSH Desktop / runtime with `llm-pi-ai` | Built and tested against DSH Desktop 44.7.0 (`@deepseek-ai/dsh-desktop@0.2.1-rc.5`). |
| An OpenCode API key | Defaults to the `OPENCODE_API_KEY` environment variable or the DSH credentials entry of the same name. |
| The `llm-pi-ai` provider row | Present in the default profile as the `opencode-go` route. |

The plugin never reads the key value into logs, tool output, or settings.

## Install

Release archives are produced by `npm pack` and attached to GitHub Releases as
`dsh-opencode-model-sync-<version>.tgz`. See the
[latest release](https://github.com/Viyangle/dsh-opencode-model-sync/releases/latest).

### From Plugin Manager

1. Download the `.tgz` from the latest release.
2. Install it as a bundle. With an agent that has Plugin Manager, use
   `install_bundle` with the downloaded file's absolute path (or with the
   unpacked directory). The same action works from DSH's plugin UI where a local
   package path is accepted.
3. Enable the bundle when asked. DSH applies it immediately when HMR is
   available; otherwise restart DSH.

### From a checkout

```text
install_bundle target: /absolute/path/to/dsh-opencode-model-sync
```

A linked checkout is used in place, so edits to the plugin are picked up by the
next recomposition/restart.

## What it creates

The plugin groups the live catalog by wire protocol and maintains three
provider routes under the `llm-pi-ai` settings section:

| Route | DSH protocol | Endpoint from the catalog |
| --- | --- | --- |
| `opencode-go-chat` | `openai-completions` | `https://opencode.ai/inference/go/openai/v1` |
| `opencode-go-anthropic` | `anthropic-messages` | `https://opencode.ai/inference/go/anthropic/v1` |
| `opencode-go-responses` | `openai-responses` | `https://opencode.ai/inference/go/openai/v1` |

Each route carries its models, context/output limits, image support, and
reasoning levels translated from the catalog. Models served over protocols DSH
cannot speak (currently `generate-content` for Gemini models) are skipped.

The bundled `opencode-go` route is **not modified**. DSH's adapter takes the
wire protocol at the route level, so a live catalog that spans three protocols
cannot be represented by one provider route without dropping its session
header and compatibility quirks. Leaving the bundled route intact means an
existing default model selection keeps working while the synced routes take
over discovery of new models.

## Usage

Select any model from **OpenCode Go · Chat Completions**, **OpenCode Go ·
Messages**, or **OpenCode Go · Responses** in the model picker. New catalog
entries show up after the next sync.

### Manual sync with the agent tool

The plugin registers one tool:

```text
opencode_model_sync action=status
opencode_model_sync action=sync
opencode_model_sync action=sync dryRun=true
opencode_model_sync action=remove
```

- `status` — last attempt/success, last error, and the live model count each
  generated route currently reports.
- `sync` — fetch the catalog now. Only changed routes are written.
- `remove` — delete the three generated routes from settings.

## Configuration

Configuration is the bundle row's `config` in the Cordis patch. Defaults are
shown below; every field is optional.

```yaml
- id: opencode-model-sync
  name: dsh-opencode-model-sync
  config:
    enabled: true
    syncOnStart: true
    intervalMinutes: 360
    modelsUrl: https://opencode.ai/zen/go/v1/models
    apiKeyEnv: OPENCODE_API_KEY
    routePrefix: opencode-go
    displayNamePrefix: OpenCode Go
    sessionId: 00000000-0000-7000-8000-000000000000
    retiredModels: drop
    excludeModels: []
    timeoutMs: 20000
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. Off registers no tool and performs no sync. |
| `syncOnStart` | `true` | Run a sync a few seconds after DSH starts. |
| `intervalMinutes` | `360` | Automatic refresh period. `0` disables the periodic refresh. |
| `modelsUrl` | `https://opencode.ai/zen/go/v1/models` | Catalog endpoint. The chat base URLs come from each model record, not from this URL. |
| `apiKeyEnv` | `OPENCODE_API_KEY` | Credential reference / environment variable name. |
| `routePrefix` | `opencode-go` | Prefix of the three managed routes (`<prefix>-chat`, `<prefix>-anthropic`, `<prefix>-responses`). |
| `displayNamePrefix` | `OpenCode Go` | Display prefix shown in the model picker. |
| `sessionId` | `00000000-0000-7000-8000-000000000000` | Value of the required `x-opencode-session` header. All conversations on the generated routes share it. |
| `retiredModels` | `drop` | `drop` follows the live catalog; `keep` keeps models that disappeared from the catalog on the same route. |
| `excludeModels` | `[]` | Model ids that must never be synced. |
| `timeoutMs` | `20000` | Catalog fetch timeout. |

Keep the `routePrefix` stable: changing it creates a new set of routes and
leaves the old ones behind (`action=remove` cleans up the current prefix).

## How it works

1. Resolve the API key through `ctx.credentials` (falling back to the Host
   process environment).
2. `GET <modelsUrl>` with a bearer token.
3. Translate every `type: chat` record by its protocol: limits →
   `contextWindow`/`maxTokens`, image modalities → `input: [text, image]`,
   reasoning levels → `reasoningEfforts` (`none` becomes `off`).
4. Group records into one route per supported protocol and add the
   `x-opencode-session` header plus DSH's `thinkingFormat: deepseek`
   compatibility switch on Chat Completions.
5. Compare with the current `llm-pi-ai` provider values and call
   `ctx.settings.update('llm-pi-ai', …)` only when something changed.

The write goes through DSH's settings service, so the profile patch stays
human-readable and the pi-ai adapter rebuilds on the next request.

## Known limitations

- **Cost is not synced.** DSH's provider configuration has no cost field; synced
  models report zero cost in the usage panel.
- **The bundled `opencode-go` route remains.** While DSH ships an older snapshot,
  the same model can appear under both the bundled route and a synced route.
- **One session id for every conversation.** Generated routes are hand-declared
  providers, and only the bundled catalog provider receives DSH's per-session
  `x-opencode-session` header. A fixed value satisfies the gateway but may
  reduce upstream cache affinity across conversations.
- **Gemini `generate-content` models are skipped** because DSH implements only
  `openai-completions`, `anthropic-messages`, and `openai-responses`.
- **Catalog metadata is the only source.** If OpenCode advertises a wrong limit
  or modality, the synced route inherits that error.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `no API key` in status/error | Export `OPENCODE_API_KEY`, or store it in DSH credentials under that name. |
| HTTP 401/403 | The key is present but not accepted by the catalog endpoint. A `403 unsupported_country_region_territory` means that model is unavailable in your region — not a plugin failure. |
| HTTP 404 | `modelsUrl` was changed away from `https://opencode.ai/zen/go/v1/models`. |
| Tool says `llm-pi-ai settings entry is not available` | The `llm-pi-ai` plugin row is disabled or missing in this profile. |
| New models absent after sync | Run `action=status`; the model count per route shows whether the write reached the adapter. Some pickers cache until the next session. |
| Settings conflict | The plugin retries once; if it persists, another settings writer is editing the same entry concurrently. |

## Uninstall

`plugin_manager action=remove_bundle target=dsh-opencode-model-sync`, then run
`opencode_model_sync action=remove` beforehand if you also want the generated
providers deleted from the profile patch.

## Development

```bash
npm test          # pure catalog translation tests (node:test, no dependencies)
npm run check     # parse every module
npm pack          # release tarball
```

The package has no build step: `index.js` and `lib/*.js` are the shipped
modules. Peer dependencies (`@deepseek-ai/dsh-tools`,
`@deepseek-ai/dsh-credentials`, `@deepseek-ai/schemastery`) are resolved by the
DSH runtime, not installed from npm.

## License

MIT. See [LICENSE](LICENSE).
