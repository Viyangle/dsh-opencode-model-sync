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
import { buildRoutes, routeIdsFor } from './catalog.js'

/** Settings namespace owned by the bundled pi-ai adapter. */
const SETTINGS_NS = 'llm-pi-ai'

const JSON_HEADERS = Object.freeze({ accept: 'application/json' })

/** Stable JSON projection used for change detection (key order independent). */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

/** Compare two JSON-shaped values ignoring object key order. */
function deepEqual(left, right) {
  return canonical(left) === canonical(right)
}

/** Model ids added and removed between two route configurations. */
function diffModels(before, after) {
  const beforeIds = new Set((Array.isArray(before?.models) ? before.models : [])
    .map(model => model?.id)
    .filter(id => typeof id === 'string'))
  const afterIds = new Set((after?.models ?? []).map(model => model.id))
  return {
    added: [...afterIds].filter(id => !beforeIds.has(id)),
    removed: [...beforeIds].filter(id => !afterIds.has(id)),
  }
}

function nowIso() {
  return new Date().toISOString()
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
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
   * Fetch and parse the OpenCode catalog.
   * @param {string} apiKey - bearer token.
   * @param {AbortSignal} signal - cancellation from the plugin/tool.
   * @returns {Promise<Record<string, unknown>>} parsed payload.
   */
  async fetchCatalog(apiKey, signal) {
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
      throw new Error(`catalog fetch failed: ${messageOf(error)}`)
    }

    if (!response.ok) {
      const detail = await response.text().then(text => text.trim().slice(0, 200)).catch(() => '')
      throw new Error(`catalog endpoint answered HTTP ${response.status}${detail.length > 0 ? `: ${detail}` : ''}`)
    }

    const text = await response.text()
    try {
      return JSON.parse(text)
    } catch {
      throw new Error('catalog endpoint returned invalid JSON')
    }
  }

  /**
   * Merge the live routes with the current profile state.
   * @param {{ routes: Array<{ id: string, config: Record<string, any> }> }} built - translated routes.
   * @param {Record<string, any>} providers - current `llm-pi-ai` providers.
   * @returns {Array<{ id: string, config: Record<string, any>, before: any, added: string[], removed: string[] }>}
   */
  planRoutes(built, providers) {
    return built.routes.map(route => {
      const before = providers[route.id]
      const config = structuredClone(route.config)
      if (this.options.retiredModels === 'keep' && Array.isArray(before?.models)) {
        const known = new Set(config.models.map(model => model.id))
        const retired = before.models.filter(model => model !== null
          && typeof model === 'object'
          && typeof model.id === 'string'
          && !known.has(model.id))
        if (retired.length > 0) config.models = [...config.models, ...structuredClone(retired)]
      }
      const { added, removed } = diffModels(before, config)
      return { id: route.id, config, before, added, removed }
    })
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
      const planned = this.planRoutes(built, providers)
      const changed = planned.filter(route => !deepEqual(route.before, route.config))
      const stale = routeIdsFor(this.options).filter(id => Object.hasOwn(providers, id)
        && !built.routes.some(route => route.id === id))
      const warnings = [...built.warnings]
      for (const id of stale) {
        warnings.push(`route "${id}" exists but the live catalog no longer advertises models for it; run action=remove then action=sync to drop it`)
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

      const at = nowIso()
      const result = {
        ok: true,
        action: 'sync',
        reason,
        dryRun,
        changed: changed.length > 0,
        applied: changed.length > 0 && !dryRun,
        at,
        modelCount: built.modelCount,
        routeCount: planned.length,
        routes,
        skipped: built.skipped,
        warnings,
      }

      if (changed.length > 0 && !dryRun) {
        this.state.lastSuccessAt = at
        this.state.lastResult = { at, reason, modelCount: built.modelCount, routes }
        this.ctx.logger.info(
          'opencode-model-sync: %s sync applied %d models across %d route(s)',
          reason,
          built.modelCount,
          planned.length,
        )
      } else if (changed.length === 0) {
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
    const ids = routeIdsFor(this.options)
    for (let attempt = 0; attempt < 2; attempt++) {
      const { revision, providers } = this.readSettings()
      const existing = ids.filter(id => Object.hasOwn(providers, id))
      if (existing.length === 0) {
        this.state.lastResult = undefined
        return { ok: true, action: 'remove', changed: false, removed: [] }
      }
      try {
        await this.ctx.settings.mutate(
          SETTINGS_NS,
          existing.map(id => ({ op: 'unset', path: ['providers', id] })),
          revision,
        )
        this.state.lastResult = undefined
        this.ctx.logger.info('opencode-model-sync: removed %d generated route(s)', existing.length)
        return { ok: true, action: 'remove', changed: true, removed: existing }
      } catch (error) {
        if (error?.code !== 'SETTINGS_CONFLICT' || attempt === 1) throw error
      }
    }
    return { ok: false, action: 'remove', error: 'settings changed repeatedly while removing routes' }
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
        excludeModels: this.options.excludeModels,
      },
      routes: routeIdsFor(this.options),
      live: await this.liveCounts(),
    }
    if (this.state.lastAttemptAt !== undefined) status.lastAttemptAt = this.state.lastAttemptAt
    if (this.state.lastSuccessAt !== undefined) status.lastSuccessAt = this.state.lastSuccessAt
    if (this.state.lastError !== undefined) status.lastError = this.state.lastError
    if (this.state.lastResult !== undefined) status.lastSync = this.state.lastResult
    return status
  }
}
