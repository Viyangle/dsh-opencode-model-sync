/**
 * Plugin identity, defaults, and the schemastery Config schema.
 *
 * The Config surface is deliberately small: the plugin is meant to work with
 * zero configuration for the common case (an `OPENCODE_API_KEY` in the user
 * environment) and to expose only the knobs that change *what* is synced.
 *
 * @module dsh-opencode-model-sync/config
 */
import z from '@deepseek-ai/schemastery'

/** Loader entry id also used as the settings namespace by Plugin Manager. */
export const name = 'opencode-model-sync'

/** Catalog endpoint published by OpenCode. The chat base URLs live elsewhere. */
export const DEFAULT_MODELS_URL = 'https://opencode.ai/zen/go/v1/models'

/** Environment variable / credential reference the routes authenticate with. */
export const DEFAULT_API_KEY_ENV = 'OPENCODE_API_KEY'

/** Prefix of every generated provider route: `<prefix>-chat`, `-anthropic`, `-responses`. */
export const DEFAULT_ROUTE_PREFIX = 'opencode-go'

/** Human prefix of every generated route `displayName`. */
export const DEFAULT_DISPLAY_PREFIX = 'OpenCode Go'

/**
 * OpenCode's gateway requires an `x-opencode-session` header on every chat
 * request. DSH only adds it for catalog-owned providers, and generated routes
 * are hand-declared providers, so the plugin supplies a fixed value. The
 * header only affects upstream routing/caching affinity, not authentication.
 */
export const DEFAULT_SESSION_ID = '00000000-0000-7000-8000-000000000000'

/** Network timeout for one catalog fetch. */
export const DEFAULT_TIMEOUT_MS = 20000

/** Automatic refresh period. `0` disables the periodic refresh only. */
export const DEFAULT_INTERVAL_MINUTES = 360

/** Resolved defaults, also used when the plugin runs without a Config object. */
export const DEFAULTS = Object.freeze({
  enabled: true,
  syncOnStart: true,
  intervalMinutes: DEFAULT_INTERVAL_MINUTES,
  modelsUrl: DEFAULT_MODELS_URL,
  apiKeyEnv: DEFAULT_API_KEY_ENV,
  routePrefix: DEFAULT_ROUTE_PREFIX,
  displayNamePrefix: DEFAULT_DISPLAY_PREFIX,
  sessionId: DEFAULT_SESSION_ID,
  retiredModels: 'drop',
  retireBundledRoute: false,
  excludeModels: [],
  timeoutMs: DEFAULT_TIMEOUT_MS,
})

/**
 * Merge user configuration over the defaults and coerce the values the rest of
 * the plugin relies on. Cordis normally applies the schema defaults, but the
 * engine is also used directly by tests and by a bare `apply(ctx, {})`.
 *
 * @param {Record<string, unknown> | undefined} config - raw Loader config.
 * @returns {typeof DEFAULTS & { excludeModels: string[] }} resolved options.
 */
export function resolveOptions(config) {
  const source = config ?? {}
  const options = { ...DEFAULTS, ...source }

  options.enabled = options.enabled !== false
  options.syncOnStart = options.syncOnStart !== false
  options.intervalMinutes = Number.isFinite(options.intervalMinutes) && options.intervalMinutes > 0
    ? options.intervalMinutes
    : 0
  options.timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs >= 1000
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS
  options.excludeModels = Array.isArray(options.excludeModels)
    ? [...new Set(options.excludeModels.filter(value => typeof value === 'string' && value.length > 0))]
    : []
  options.retiredModels = options.retiredModels === 'keep' ? 'keep' : 'drop'
  options.retireBundledRoute = options.retireBundledRoute === true
  for (const key of ['modelsUrl', 'apiKeyEnv', 'routePrefix', 'displayNamePrefix', 'sessionId']) {
    if (typeof options[key] !== 'string') options[key] = DEFAULTS[key]
  }
  return options
}

/** User-facing configuration schema. */
export const Config = z.object({
  enabled: z.boolean()
    .default(DEFAULTS.enabled)
    .description('Master switch. When off, the plugin registers nothing and stops syncing.'),
  syncOnStart: z.boolean()
    .default(DEFAULTS.syncOnStart)
    .description('Refresh the catalog a few seconds after DSH starts.'),
  intervalMinutes: z.number().min(0)
    .default(DEFAULTS.intervalMinutes)
    .description('Minutes between automatic refreshes. 0 disables periodic refresh; sync on start and the manual tool still work.'),
  modelsUrl: z.string()
    .default(DEFAULTS.modelsUrl)
    .description('OpenCode model-listing endpoint. The chat base URLs are read from each model record, not from this URL.'),
  apiKeyEnv: z.string()
    .default(DEFAULTS.apiKeyEnv)
    .description('Credential reference / environment variable holding the OpenCode API key.'),
  routePrefix: z.string()
    .default(DEFAULTS.routePrefix)
    .description('Prefix of the generated provider routes. The plugin owns <prefix>-chat, <prefix>-anthropic, and <prefix>-responses.'),
  displayNamePrefix: z.string()
    .default(DEFAULTS.displayNamePrefix)
    .description('Display-name prefix of the generated provider routes.'),
  sessionId: z.string()
    .default(DEFAULTS.sessionId)
    .description('Value sent as x-opencode-session, which the OpenCode gateway requires. Shared by every conversation on the generated routes.'),
  retiredModels: z.union(['drop', 'keep'])
    .default(DEFAULTS.retiredModels)
    .description('drop: follow the live catalog. keep: retain models that disappeared from the catalog on the same route.'),
  retireBundledRoute: z.boolean()
    .default(DEFAULTS.retireBundledRoute)
    .description('Remove the bundled opencode-go provider route after a sync and move the default model to the matching generated route. One-way: turning it off later does not restore the route.'),
  excludeModels: z.array(z.string())
    .default([])
    .description('Model ids that must never be synced (for example models you do not want in the picker).'),
  timeoutMs: z.number().min(1000)
    .default(DEFAULTS.timeoutMs)
    .description('Catalog fetch timeout in milliseconds.'),
})
