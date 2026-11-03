/**
 * Pure translation from the OpenCode model catalog to DSH `llm-pi-ai` routes.
 *
 * DSH's `llm-pi-ai` provider takes the wire protocol at the *route* level, while
 * OpenCode serves one catalog over three different endpoints. The only
 * supported way to add models that the bundled snapshot does not describe is
 * therefore to group the catalog by protocol and emit one route per protocol.
 *
 * Everything in this module is pure so it can be unit-tested without a Host.
 *
 * @module dsh-opencode-model-sync/catalog
 */

/** Model entries assumed when a record omits its limits (DSH's own defaults). */
export const DEFAULT_CONTEXT_WINDOW = 262144
export const DEFAULT_MAX_TOKENS = 32768

/** Reasoning levels DSH accepts as `reasoningEfforts` keys, in display order. */
export const THINKING_LEVELS = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/**
 * One OpenCode protocol key and the DSH protocol that serves it.
 * `generate-content` (Gemini) has no DSH implementation and is intentionally absent.
 */
export const SUPPORTED_PROTOCOLS = Object.freeze([
  Object.freeze({
    source: 'chat-completions',
    api: 'openai-completions',
    slug: 'chat',
    label: 'Chat Completions',
  }),
  Object.freeze({
    source: 'messages',
    api: 'anthropic-messages',
    slug: 'anthropic',
    label: 'Messages',
  }),
  Object.freeze({
    source: 'responses',
    api: 'openai-responses',
    slug: 'responses',
    label: 'Responses',
  }),
])

/** OpenCode spells "no reasoning" as `none`; DSH spells it `off`. */
const LEVEL_ALIASES = Object.freeze({ none: 'off' })

const IMAGE_PREFIX = 'image/'

/**
 * Normalize a route prefix into a provider id fragment.
 * @param {string} value - configured prefix.
 * @returns {string} lowercase `[a-z0-9-]` slug.
 */
export function slugify(value) {
  const slug = String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : 'opencode-go'
}

/**
 * Provider route id owned for one protocol.
 * @param {{ routePrefix: string }} options - resolved plugin options.
 * @param {{ slug: string }} protocol - one entry of {@link SUPPORTED_PROTOCOLS}.
 * @returns {string} route id.
 */
export function routeIdFor(options, protocol) {
  return `${slugify(options.routePrefix)}-${protocol.slug}`
}

/**
 * Every route id the plugin owns, in protocol order.
 * @param {{ routePrefix: string }} options - resolved plugin options.
 * @returns {string[]} route ids.
 */
export function routeIdsFor(options) {
  return SUPPORTED_PROTOCOLS.map(protocol => routeIdFor(options, protocol))
}

/** Throw when a value cannot be a single-line HTTP header value. */
function assertHeaderValue(label, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must not contain control characters`)
  }
}

/** Positive integer or `undefined`. */
function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * Translate OpenCode reasoning capabilities into DSH `reasoningEfforts`.
 *
 * - `supported: false` → `false` (explicitly not a reasoning model).
 * - a non-empty effort list → a level map; `none` becomes `off`, and `off`
 *   carries `null` so dispatch sends no thinking parameter.
 * - a reasoning model with no advertised levels → `undefined`, which keeps the
 *   bundled catalog's capability when the model is already known.
 *
 * @param {Record<string, any>} model - one catalog record.
 * @returns {false | Record<string, string | null> | undefined} DSH value.
 */
export function reasoningEffortsOf(model) {
  const capability = model?.capabilities?.reasoning
  if (capability === undefined || capability === null) return undefined
  if (capability.supported === false) return false
  if (capability.supported !== true) return undefined

  const declared = Array.isArray(capability.effort) ? capability.effort : []
  const levels = {}
  for (const raw of declared) {
    if (typeof raw !== 'string') continue
    const level = LEVEL_ALIASES[raw] ?? raw
    if (!THINKING_LEVELS.includes(level)) continue
    levels[level] = level === 'off' ? null : level
  }

  const ordered = {}
  for (const level of THINKING_LEVELS) {
    if (Object.hasOwn(levels, level)) ordered[level] = levels[level]
  }
  return Object.keys(ordered).some(level => level !== 'off') ? ordered : undefined
}

/**
 * DSH input modalities for one catalog record.
 * Under-claiming is safer than over-claiming: text is always assumed.
 * @param {Record<string, any>} model - one catalog record.
 * @returns {string[]} `['text']` or `['text', 'image']`.
 */
export function inputModalitiesOf(model) {
  const inputs = Array.isArray(model?.modalities?.input) ? model.modalities.input : []
  const hasImage = inputs.some(value => typeof value === 'string' && value.toLowerCase().startsWith(IMAGE_PREFIX))
  return hasImage ? ['text', 'image'] : ['text']
}

/**
 * One `models[]` entry for a DSH provider route.
 * @param {Record<string, any>} model - one catalog record.
 * @returns {Record<string, any>} route-local model profile.
 */
export function modelEntryOf(model) {
  const contextWindow = positiveInteger(model?.limit?.context) ?? DEFAULT_CONTEXT_WINDOW
  const maxTokens = positiveInteger(model?.limit?.output) ?? DEFAULT_MAX_TOKENS
  const name = typeof model?.name === 'string' && model.name.trim().length > 0 ? model.name.trim() : model.id
  const reasoningEfforts = reasoningEffortsOf(model)
  return {
    id: model.id,
    name,
    contextWindow,
    maxTokens,
    input: inputModalitiesOf(model),
    ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
  }
}

/** The most frequently used base URL, preserving first-seen order for ties. */
function dominantBaseUrl(baseUrls) {
  const counts = new Map()
  for (const url of baseUrls) counts.set(url, (counts.get(url) ?? 0) + 1)
  let winner
  let winnerCount = -1
  for (const [url, count] of counts) {
    if (count > winnerCount) {
      winner = url
      winnerCount = count
    }
  }
  return winner
}

/**
 * Convert the catalog's OpenAI-style base URL into the base URL pi-ai's SDK for
 * that protocol expects.
 *
 * OpenCode publishes every base URL with the version segment included (for
 * example `…/anthropic/v1`). The OpenAI SDK appends `/chat/completions` or
 * `/responses`, so those bases stay as-is. The Anthropic SDK appends
 * `/v1/messages`, so a trailing `/v1` must be removed or the request lands on
 * `…/v1/v1/messages` and the gateway answers 404.
 *
 * @param {{ api: string }} protocol - one entry of {@link SUPPORTED_PROTOCOLS}.
 * @param {string} baseUrl - catalog-provided base URL.
 * @returns {string} base URL for the DSH route.
 */
export function routeBaseUrl(protocol, baseUrl) {
  const trimmed = String(baseUrl).trim().replace(/\/+$/, '')
  return protocol.api === 'anthropic-messages' ? trimmed.replace(/\/v1$/i, '') : trimmed
}

/** Stable, locale-independent id ordering. */
function compareIds(left, right) {
  if (left.id === right.id) return 0
  return left.id < right.id ? -1 : 1
}

/**
 * Group a catalog payload into one DSH provider route per supported protocol.
 *
 * @param {{ data?: unknown }} payload - parsed response of the models endpoint.
 * @param {{
 *   routePrefix: string,
 *   displayNamePrefix: string,
 *   apiKeyEnv: string,
 *   sessionId: string,
 *   excludeModels: string[],
 * }} options - resolved plugin options.
 * @returns {{
 *   routes: Array<{ id: string, config: Record<string, any> }>,
 *   modelCount: number,
 *   skipped: Array<{ id: string, reason: string }>,
 *   warnings: string[],
 * }} routes plus a diagnostic list.
 */
export function buildRoutes(payload, options) {
  if (payload === null || typeof payload !== 'object' || !Array.isArray(payload.data)) {
    throw new Error('the models endpoint did not return an object with a "data" array')
  }
  assertHeaderValue('sessionId', options.sessionId)
  assertHeaderValue('apiKeyEnv', options.apiKeyEnv)

  const excluded = new Set(options.excludeModels ?? [])
  const skipped = []
  const warnings = []
  const considered = []

  for (const record of payload.data) {
    if (record === null || typeof record !== 'object') continue
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    if (id.length === 0) {
      skipped.push({ id: '(anonymous)', reason: 'missing-id' })
      continue
    }
    if (record.type !== undefined && record.type !== 'chat') {
      skipped.push({ id, reason: `unsupported-type:${record.type}` })
      continue
    }
    if (excluded.has(id)) {
      skipped.push({ id, reason: 'excluded' })
      continue
    }
    const api = record.api
    const supported = SUPPORTED_PROTOCOLS.filter(protocol => api !== null
      && typeof api === 'object'
      && api[protocol.source] !== null
      && typeof api[protocol.source] === 'object')
    if (supported.length === 0) {
      const keys = api !== null && typeof api === 'object' ? Object.keys(api).join(', ') : 'none'
      skipped.push({ id, reason: `unsupported-api:${keys}` })
      continue
    }
    considered.push({ record, id, supported })
  }

  const routes = []
  const seenModelIds = new Set()
  for (const protocol of SUPPORTED_PROTOCOLS) {
    const entries = []
    const baseUrls = []
    const seen = new Set()
    for (const { record, id, supported } of considered) {
      if (!supported.some(candidate => candidate.source === protocol.source)) continue
      const apiMeta = record.api[protocol.source]
      const rawBaseUrl = typeof apiMeta.base_url === 'string' ? apiMeta.base_url.trim() : ''
      if (!/^https?:\/\//i.test(rawBaseUrl)) {
        warnings.push(`model "${id}" has no usable ${protocol.source} base_url; skipped for the ${protocol.api} route`)
        continue
      }
      if (seen.has(id)) continue
      seen.add(id)
      seenModelIds.add(id)
      baseUrls.push(routeBaseUrl(protocol, rawBaseUrl))
      entries.push(modelEntryOf(record))
    }
    if (entries.length === 0) continue
    entries.sort(compareIds)

    const baseURL = dominantBaseUrl(baseUrls)
    if (new Set(baseUrls).size > 1) {
      warnings.push(`the ${protocol.source} models use ${new Set(baseUrls).size} different base URLs; using ${baseURL}`)
    }

    routes.push({
      id: routeIdFor(options, protocol),
      config: {
        displayName: `${options.displayNamePrefix} · ${protocol.label}`.trim(),
        api: protocol.api,
        baseURL,
        apiKeyEnv: options.apiKeyEnv,
        headers: { 'x-opencode-session': options.sessionId },
        ...(protocol.api === 'openai-completions' ? { compat: { thinkingFormat: 'deepseek' } } : {}),
        models: entries,
      },
    })
  }

  return {
    routes,
    modelCount: seenModelIds.size,
    skipped,
    warnings,
  }
}
