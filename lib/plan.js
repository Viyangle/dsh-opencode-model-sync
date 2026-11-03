/**
 * Pure planning for a sync: merging the live routes with the current profile
 * state, protecting providers the plugin does not own, and computing the diff
 * a caller reports.
 *
 * Everything here is synchronous and dependency-free so the edge cases can be
 * unit-tested without a Host.
 *
 * @module dsh-opencode-model-sync/plan
 */

/** Stable JSON projection used for change detection (key order independent). */
export function canonical(value) {
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
export function deepEqual(left, right) {
  return canonical(left) === canonical(right)
}

/** Model ids added and removed between two route configurations. */
export function diffModels(before, after) {
  const beforeIds = new Set((Array.isArray(before?.models) ? before.models : [])
    .map(model => model?.id)
    .filter(id => typeof id === 'string'))
  const afterIds = new Set((after?.models ?? []).map(model => model.id))
  return {
    added: [...afterIds].filter(id => !beforeIds.has(id)),
    removed: [...beforeIds].filter(id => !afterIds.has(id)),
  }
}

/**
 * Refuse to overwrite a provider that the plugin does not own.
 *
 * A previous version of this plugin always wrote `api` on its routes, so the
 * protocol is a stable ownership marker: an existing provider with the same id
 * but a different protocol is somebody else's route. The guard is intentionally
 * narrow — baseURL and model changes are allowed so the plugin can evolve its
 * own output.
 *
 * @param {{ id: string, config: Record<string, any>, before: any }} route - planned route.
 * @throws When the existing provider belongs to someone else.
 */
export function assertRouteOwnership(route) {
  const existing = route.before
  if (existing === undefined) return
  if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) {
    throw new Error(`refusing to overwrite provider "${route.id}": its current configuration is not an object`)
  }
  if (existing.api !== route.config.api) {
    throw new Error(
      `refusing to overwrite provider "${route.id}": it uses api "${existing.api ?? '(none)'}" but this route needs "${route.config.api}"; change routePrefix or remove that provider first`,
    )
  }
}

/**
 * Merge the live routes with the current `llm-pi-ai` provider values.
 *
 * `retiredModels: keep` retains models that disappeared from the catalog, but
 * never resurrects an explicitly excluded model and never duplicates a model
 * that is still live on another protocol route.
 *
 * @param {Array<{ id: string, config: Record<string, any> }>} routes - translated routes.
 * @param {Record<string, any>} providers - current `llm-pi-ai` providers.
 * @param {{ retiredModels?: string, excludeModels?: string[] }} options - relevant options.
 * @returns {Array<{
 *   id: string,
 *   config: Record<string, any>,
 *   before: any,
 *   added: string[],
 *   removed: string[],
 *   changed: boolean,
 * }>} planned routes.
 */
export function planRoutes(routes, providers, options) {
  const excluded = new Set(options.excludeModels ?? [])
  const liveIds = new Set()
  for (const route of routes) {
    for (const model of route.config.models) liveIds.add(model.id)
  }

  return routes.map(route => {
    const before = providers[route.id]
    const config = structuredClone(route.config)

    if (options.retiredModels === 'keep' && Array.isArray(before?.models)) {
      const known = new Set(config.models.map(model => model.id))
      const retired = before.models.filter(model => model !== null
        && typeof model === 'object'
        && typeof model.id === 'string'
        && model.id.length > 0
        && !known.has(model.id)
        && !excluded.has(model.id)
        && !liveIds.has(model.id))
      if (retired.length > 0) config.models = [...config.models, ...structuredClone(retired)]
    }

    const planned = {
      id: route.id,
      config,
      before,
      ...diffModels(before, config),
      changed: false,
    }
    assertRouteOwnership(planned)
    planned.changed = !deepEqual(before, config)
    return planned
  })
}
