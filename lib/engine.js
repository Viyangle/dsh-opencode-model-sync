/**
 * The sync engine: fetch the live catalog, translate it into provider routes,
 * and persist them through the `settings` service of `llm-pi-ai`.
 *
 * The engine never touches another provider: it only writes the three route
 * keys it derives from `routePrefix`. Existing user profiles, credentials, and
 * unrelated provider routes are passed through untouched.
 *
 * @module dsh-opencode-model-sync/engine
 */
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { SUPPORTED_PROTOCOLS, buildRoutes, routeIdFor, routeIdsFor } from './catalog.js'
import { isBundledRouteRetirable, planRoutes, routeForModel } from './plan.js'

/** Settings namespace owned by the bundled pi-ai adapter. */
const SETTINGS_NS = 'llm-pi-ai'

/** Profile entry holding the default model selection. */
const AGENT_DEFAULT_MODEL_NS = 'agent-default-model'

/** The bundled provider route this plugin supersedes. */
const BUNDLED_ROUTE = 'opencode-go'

const JSON_HEADERS = Object.freeze({ accept: 'application/json' })

/** One retry for a transient catalog failure. */
const FETCH_RETRY_DELAY_MS = 1000

function nowIso() {
  return new Date().toISOString()
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Mark an error as worth one retry. */
function retryable(error) {
  error.retryable = true
  return error
}

/** Sleep that settles early when the sync is cancelled. */
function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('catalog fetch was cancelled'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('catalog fetch was cancelled'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    timer.unref?.()
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * One plugin instance's sync lifecycle. All state is per-instance, so a config
 * edit that remounts the plugin starts clean.
 */
export class SyncEngine {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
   * @param {ReturnType<import('./config.js').resolveOptions>} options - resolved options.
   */
  constructor(ctx, options) {
    this.ctx = ctx
    this.options = options
    this.inflight = undefined
    this.controller = undefined
    this.state = {
      lastAttemptAt: undefined,
      lastSuccessAt: undefined,
      lastError: undefined,
      lastResult: undefined,
    }
  }

  /** Abort an in-flight fetch when the plugin is disposed. */
  dispose() {
    this.controller?.abort(new Error('opencode-model-sync was disposed'))
    this.controller = undefined
  }

  /**
   * Read the raw profile-level configuration of `llm-pi-ai` and the revision
   * the settings form currently stands at.
   * @returns {{ revision: number, providers: Record<string, any> }} current state.
   */
  readSettings() {
    const entries = this.ctx.settings.describe()
    const entry = entries.find(candidate => candidate.ns === SETTINGS_NS)
    if (entry === undefined) {
      throw new Error(`the "${SETTINGS_NS}" settings entry is not available in this profile; enable the llm-pi-ai plugin first`)
    }
    const providers = entry.user?.providers
    return {
      revision: entry.revision,
      providers: providers !== null && typeof providers === 'object' ? providers : {},
    }
  }

  /**
   * Resolve the API key through the credentials seam, then the Host process
   * environment. Never logs the value.
   * @returns {Promise<string | undefined>} the key, when configured.
   */
  async resolveApiKey() {
    const reference = this.options.apiKeyEnv
    let ref
    try {
      ref = credentialRef(reference)
    } catch {
      throw new Error(`apiKeyEnv "${reference}" is not a valid credential reference (expected an environment-variable name)`)
    }

    const credentials = this.ctx.get('credentials')
    if (credentials !== undefined) {
      try {
        const hit = await credentials.resolve(ref)
        if (typeof hit?.value === 'string' && hit.value.length > 0) return hit.value
      } catch (error) {
        this.ctx.logger.debug('opencode-model-sync: credential lookup failed for %s: %s', reference, messageOf(error))
      }
    }

    const ambient = process.env[reference]
    return typeof ambient === 'string' && ambient.trim().length > 0 ? ambient.trim() : undefined
  }

  /**
   * Fetch and parse the OpenCode catalog, retrying one transient failure.
   * @param {string} apiKey - bearer token.
   * @param {AbortSignal} signal - cancellation from the plugin/tool.
   * @returns {Promise<Record<string, unknown>>} parsed payload.
   */
  async fetchCatalog(apiKey, signal) {
    try {
      return await this.fetchCatalogOnce(apiKey, signal)
    } catch (error) {
      if (error?.retryable !== true || signal.aborted) throw error
      this.ctx.logger.warn('opencode-model-sync: catalog fetch failed (%s); retrying once', messageOf(error))
      await delay(FETCH_RETRY_DELAY_MS, signal)
      return await this.fetchCatalogOnce(apiKey, signal)
    }
  }

  /**
   * One catalog request.
   * @param {string} apiKey - bearer token.
   * @param {AbortSignal} signal - cancellation from the plugin/tool.
   * @returns {Promise<Record<string, unknown>>} parsed payload.
   */
  async fetchCatalogOnce(apiKey, signal) {
    const timeout = AbortSignal.timeout(this.options.timeoutMs)
    const combined = typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : timeout
    let response
    try {
      response = await fetch(this.options.modelsUrl, {
        method: 'GET',
        headers: { ...JSON_HEADERS, authorization: `Bearer ${apiKey}` },
        signal: combined,
      })
    } catch (error) {
      if (signal.aborted) throw new Error('catalog fetch was cancelled')
      if (timeout.aborted) throw new Error(`catalog fetch timed out after ${this.options.timeoutMs}ms`)
      throw retryable(new Error(`catalog fetch failed: ${messageOf(error)}`))
    }

    if (!response.ok) {
      const detail = await response.text().then(text => text.trim().slice(0, 200)).catch(() => '')
      const error = new Error(`catalog endpoint answered HTTP ${response.status}${detail.length > 0 ? `: ${detail}` : ''}`)
      if (response.status >= 500 || response.status === 429) retryable(error)
      throw error
    }

    const text = await response.text()
    try {
      return JSON.parse(text)
    } catch {
      throw new Error('catalog endpoint returned invalid JSON')
    }
  }

  /**
   * Managed routes that still exist but are no longer produced by the catalog.
   * @param {Record<string, any>} providers - current `llm-pi-ai` providers.
   * @param {{ routes: Array<{ id: string }> }} built - translated routes.
   * @returns {{ owned: string[], foreign: string[] }} stale ids split by ownership.
   */
  staleRoutes(providers, built) {
    const owned = []
    const foreign = []
    for (const protocol of SUPPORTED_PROTOCOLS) {
      const id = routeIdFor(this.options, protocol)
      if (!Object.hasOwn(providers, id) || built.routes.some(route => route.id === id)) continue
      const existing = providers[id]
      if (existing !== null && typeof existing === 'object' && existing.api === protocol.api) owned.push(id)
      else foreign.push(id)
    }
    return { owned, foreign }
  }

  /**
   * Unset provider routes, retrying once when the settings revision moved.
   * @param {string[]} ids - route ids to remove.
   * @returns {Promise<string[]>} ids actually removed.
   */
  async removeRoutes(ids) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { revision, providers } = this.readSettings()
      const existing = ids.filter(id => Object.hasOwn(providers, id))
      if (existing.length === 0) return []
      try {
        await this.ctx.settings.mutate(
          SETTINGS_NS,
          existing.map(id => ({ op: 'unset', path: ['providers', id] })),
          revision,
        )
        return existing
      } catch (error) {
        if (error?.code !== 'SETTINGS_CONFLICT' || attempt === 1) throw error
      }
    }
    throw new Error('settings changed repeatedly while removing routes')
  }

  /**
   * Persist changed routes, retrying once when the settings revision moved
   * while the catalog was being fetched.
   * @param {Array<{ id: string, config: Record<string, any> }>} routes - routes to write.
   * @param {number} revision - revision read before planning.
   */
  async writeRoutes(routes, revision) {
    const patch = { providers: Object.fromEntries(routes.map(route => [route.id, route.config])) }
    try {
      await this.ctx.settings.update(SETTINGS_NS, patch, revision)
    } catch (error) {
      if (error?.code !== 'SETTINGS_CONFLICT') throw error
      const { revision: nextRevision } = this.readSettings()
      await this.ctx.settings.update(SETTINGS_NS, patch, nextRevision)
    }
  }

  /**
   * Refresh the catalog now.
   * @param {{ dryRun?: boolean, reason?: string }} [request] - sync options.
   * @returns {Promise<Record<string, any>>} structured result for the tool.
   */
  sync(request = {}) {
    if (!this.options.enabled) {
      return Promise.resolve({ ok: false, action: 'sync', error: 'the plugin is disabled by configuration' })
    }
    if (this.inflight !== undefined) return this.inflight
    this.inflight = this.runSync(request).finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }

  /** Internal sync body. */
  async runSync({ dryRun = false, reason = 'manual' } = {}) {
    this.state.lastAttemptAt = nowIso()
    this.state.lastError = undefined
    const controller = new AbortController()
    this.controller = controller

    try {
      const apiKey = await this.resolveApiKey()
      if (apiKey === undefined) {
        throw new Error(`no API key: set ${this.options.apiKeyEnv} in the environment or store it through the DSH credentials service`)
      }

      const payload = await this.fetchCatalog(apiKey, controller.signal)
      const built = buildRoutes(payload, this.options)
      if (built.routes.length === 0 || built.modelCount === 0) {
        throw new Error('the catalog contains no chat models in a protocol DSH can serve')
      }

      const { revision, providers } = this.readSettings()
      const planned = planRoutes(built.routes, providers, this.options)
      const changed = planned.filter(route => route.changed)
      const stale = this.staleRoutes(providers, built)
      const warnings = [...built.warnings]
      for (const id of stale.foreign) {
        warnings.push(`route "${id}" exists but belongs to another provider configuration; left untouched`)
      }
      if (stale.owned.length > 0) {
        if (this.options.retiredModels === 'keep') {
          warnings.push(`route(s) ${stale.owned.join(', ')} are stale but retained because retiredModels=keep`)
        } else if (dryRun) {
          warnings.push(`route(s) ${stale.owned.join(', ')} would be removed because the live catalog no longer produces them`)
        }
      }

      const routes = planned.map(route => ({
        route: route.id,
        api: route.config.api,
        models: route.config.models.length,
        added: route.added,
        removed: route.removed,
      }))

      if (changed.length > 0 && !dryRun) {
        await this.writeRoutes(changed, revision)
      }

      let removedRoutes = []
      if (!dryRun && stale.owned.length > 0 && this.options.retiredModels === 'drop') {
        removedRoutes = await this.removeRoutes(stale.owned)
      }

      let retiredBundledRoute = false
      if (this.options.retireBundledRoute) {
        if (dryRun) {
          const current = this.readSettings().providers
          if (Object.hasOwn(current, BUNDLED_ROUTE) && isBundledRouteRetirable(current[BUNDLED_ROUTE])) {
            warnings.push(`the bundled "${BUNDLED_ROUTE}" route would be retired after this sync`)
          }
        } else {
          retiredBundledRoute = await this.retireBundled(built.routes, warnings)
        }
      }

      const at = nowIso()
      const applied = !dryRun && (changed.length > 0 || removedRoutes.length > 0 || retiredBundledRoute)
      const result = {
        ok: true,
        action: 'sync',
        reason,
        dryRun,
        changed: changed.length > 0 || removedRoutes.length > 0 || retiredBundledRoute,
        applied,
        at,
        modelCount: built.modelCount,
        routeCount: planned.length,
        routes,
        removedRoutes,
        ...(this.options.retireBundledRoute ? { retiredBundledRoute } : {}),
        skipped: built.skipped,
        warnings,
      }

      if (applied) {
        this.state.lastSuccessAt = at
        this.state.lastResult = {
          at,
          reason,
          modelCount: built.modelCount,
          routes,
          ...(retiredBundledRoute ? { retiredBundledRoute: true } : {}),
        }
        const suffix = removedRoutes.length > 0
          ? ` and removed ${removedRoutes.join(', ')}`
          : retiredBundledRoute ? ` and retired ${BUNDLED_ROUTE}` : ''
        this.ctx.logger.info(
          'opencode-model-sync: %s sync applied %d models across %d route(s)%s',
          reason,
          built.modelCount,
          planned.length,
          suffix,
        )
      } else if (!dryRun) {
        this.state.lastSuccessAt = at
        this.state.lastResult = { at, reason, modelCount: built.modelCount, routes }
        this.ctx.logger.debug('opencode-model-sync: %s sync found no catalog changes', reason)
      } else {
        this.ctx.logger.info('opencode-model-sync: %s dry run found %d changed route(s)', reason, changed.length)
      }

      return result
    } catch (error) {
      this.state.lastError = messageOf(error)
      this.ctx.logger.warn('opencode-model-sync: %s sync failed: %s', reason, this.state.lastError)
      throw error
    } finally {
      if (this.controller === controller) this.controller = undefined
    }
  }

  /**
   * Remove every generated route from the `llm-pi-ai` settings section.
   * @returns {Promise<Record<string, any>>} removed route ids.
   */
  async remove() {
    const removed = await this.removeRoutes(routeIdsFor(this.options))
    this.state.lastResult = undefined
    if (removed.length === 0) {
      return { ok: true, action: 'remove', changed: false, removed: [] }
    }
    this.ctx.logger.info('opencode-model-sync: removed %d generated route(s)', removed.length)
    return { ok: true, action: 'remove', changed: true, removed }
  }

  /**
   * Move the default model selection off the bundled route.
   * @param {Array<{ id: string, config: { models: Array<{ id: string }> } }>} routes - generated routes.
   * @param {string[]} warnings - mutable warning list.
   * @returns {Promise<boolean>} true when nothing needs moving or the move succeeded.
   */
  async migrateDefaultModel(routes, warnings) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const entry = this.ctx.settings.describe().find(candidate => candidate.ns === AGENT_DEFAULT_MODEL_NS)
      if (entry === undefined) return true
      const provider = entry.value?.provider
      const model = entry.value?.model
      if (provider !== BUNDLED_ROUTE || typeof model !== 'string' || model.length === 0) return true

      const route = routeForModel(routes, model)
      if (route === undefined) {
        warnings.push(`default model "${BUNDLED_ROUTE}/${model}" is not served by the live catalog; set another default model before retiring the bundled route`)
        return false
      }

      try {
        await this.ctx.settings.update(AGENT_DEFAULT_MODEL_NS, { provider: route }, entry.revision)
        this.ctx.logger.info('opencode-model-sync: moved the default model to %s/%s', route, model)
        return true
      } catch (error) {
        if (error?.code !== 'SETTINGS_CONFLICT' || attempt === 1) {
          warnings.push(`could not move the default model selection: ${messageOf(error)}`)
          return false
        }
      }
    }
    return false
  }

  /**
   * Remove the bundled `opencode-go` provider route after a successful sync.
   *
   * Only the untouched default profile is removed: any custom field means the
   * route is someone's deliberate configuration. The default model selection
   * is migrated first; if that is impossible, retirement is aborted rather
   * than leaving DSH pointing at a route that no longer exists.
   *
   * @param {Array<{ id: string, config: Record<string, any> }>} routes - generated routes.
   * @param {string[]} warnings - mutable warning list.
   * @returns {Promise<boolean>} whether the route was removed.
   */
  async retireBundled(routes, warnings) {
    const { providers } = this.readSettings()
    const bundled = providers[BUNDLED_ROUTE]
    if (bundled === undefined) return false
    if (!isBundledRouteRetirable(bundled)) {
      warnings.push(`the bundled "${BUNDLED_ROUTE}" provider carries custom configuration; refusing to retire it`)
      return false
    }
    if (!await this.migrateDefaultModel(routes, warnings)) return false

    const removed = await this.removeRoutes([BUNDLED_ROUTE])
    if (removed.length === 0) return false
    this.ctx.logger.info('opencode-model-sync: retired the bundled %s route', BUNDLED_ROUTE)
    return true
  }

  /** Live model counts reported by the registered adapters, best effort. */
  async liveCounts() {
    const llm = this.ctx.get('llm')
    const counts = {}
    if (llm === undefined) return counts
    for (const route of routeIdsFor(this.options)) {
      try {
        const models = await llm.listModels(route)
        counts[route] = models.length
      } catch (error) {
        counts[route] = { error: messageOf(error) }
      }
    }
    return counts
  }

  /**
   * Compare the live catalog with the model list DSH's bundled route serves.
   * @returns {Promise<Record<string, any> | undefined>} comparison, when the llm service exists.
   */
  async bundledComparison() {
    const llm = this.ctx.get('llm')
    if (llm === undefined) return undefined

    let bundledModels
    try {
      bundledModels = await llm.listModels(BUNDLED_ROUTE)
    } catch {
      return { route: BUNDLED_ROUTE, available: false }
    }

    const bundledIds = new Set(bundledModels.map(model => model.id))
    const liveIds = new Set()
    for (const route of routeIdsFor(this.options)) {
      try {
        for (const model of await llm.listModels(route)) liveIds.add(model.id)
      } catch {
        // A route that is not registered yet cannot contribute live ids.
      }
    }

    const missingFromBundled = [...liveIds].filter(id => !bundledIds.has(id)).sort()
    const onlyInBundled = [...bundledIds].filter(id => !liveIds.has(id)).sort()
    return {
      route: BUNDLED_ROUTE,
      available: true,
      bundledModels: bundledIds.size,
      liveModels: liveIds.size,
      missingFromBundled,
      onlyInBundled,
      redundant: liveIds.size > 0 && missingFromBundled.length === 0,
    }
  }

  /**
   * Report plugin state without touching the network.
   * Optional fields are omitted while unknown: the tool boundary only accepts
   * lossless JSON, which rejects `undefined` members.
   * @returns {Promise<Record<string, any>>} status object.
   */
  async status() {
    const status = {
      ok: true,
      action: 'status',
      enabled: this.options.enabled,
      configured: {
        modelsUrl: this.options.modelsUrl,
        routePrefix: this.options.routePrefix,
        apiKeyEnv: this.options.apiKeyEnv,
        intervalMinutes: this.options.intervalMinutes,
        retiredModels: this.options.retiredModels,
        retireBundledRoute: this.options.retireBundledRoute,
        excludeModels: this.options.excludeModels,
      },
      routes: routeIdsFor(this.options),
      live: await this.liveCounts(),
    }
    const bundled = await this.bundledComparison()
    if (bundled !== undefined) status.bundled = bundled
    if (this.state.lastAttemptAt !== undefined) status.lastAttemptAt = this.state.lastAttemptAt
    if (this.state.lastSuccessAt !== undefined) status.lastSuccessAt = this.state.lastSuccessAt
    if (this.state.lastError !== undefined) status.lastError = this.state.lastError
    if (this.state.lastResult !== undefined) status.lastSync = this.state.lastResult
    return status
  }
}
