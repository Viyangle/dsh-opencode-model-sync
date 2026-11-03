/**
 * DSH OpenCode Model Sync.
 *
 * The plugin keeps three `llm-pi-ai` provider routes in sync with the live
 * OpenCode Go catalog. It never replaces the bundled `opencode-go` route and
 * never touches providers it does not own.
 *
 * @module dsh-opencode-model-sync
 */
import { Config, name, resolveOptions } from './lib/config.js'
import { SyncEngine } from './lib/engine.js'
import { registerTool } from './lib/tool.js'

export { Config, name }

/** `settings` is required: without it there is no supported write path. */
export const inject = ['settings']

/** Give the Host a moment to finish composing before the first network call. */
const STARTUP_DELAY_MS = 6000

/**
 * Run deferred work outside the HMR transaction that mounted this plugin.
 *
 * Cordis/HMR executes plugin activation inside an `AsyncLocalStorage`
 * transaction. Timers created there inherit that store, and a settings write
 * latched onto it is rejected with "HMR transactions cannot be nested" long
 * after the transaction itself finished. Exiting the store before starting the
 * sync keeps startup and periodic refreshes independent of mount timing.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {() => void} operation - work to start in a clean async context.
 */
function inCleanContext(ctx, operation) {
  const executing = ctx.get('hmr')?.executing
  if (executing !== undefined && typeof executing.exit === 'function') {
    executing.exit(operation)
    return
  }
  operation()
}

/**
 * Plugin entry.
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning context.
 * @param {Record<string, unknown>} config - resolved Loader config.
 */
export function apply(ctx, config) {
  const options = resolveOptions(config)
  if (!options.enabled) {
    ctx.logger.info('opencode-model-sync: disabled by configuration')
    return
  }

  const engine = new SyncEngine(ctx, options)
  ctx.effect(() => () => engine.dispose(), 'opencode-model-sync lifetime')
  registerTool(ctx, engine)

  if (options.syncOnStart) {
    ctx.effect(() => {
      const handle = setTimeout(() => {
        inCleanContext(ctx, () => {
          void engine.sync({ reason: 'startup' }).catch(() => {})
        })
      }, STARTUP_DELAY_MS)
      handle.unref?.()
      return () => clearTimeout(handle)
    }, 'opencode-model-sync startup sync')
  }

  if (options.intervalMinutes > 0) {
    ctx.effect(() => {
      const handle = setInterval(() => {
        inCleanContext(ctx, () => {
          void engine.sync({ reason: 'interval' }).catch(() => {})
        })
      }, options.intervalMinutes * 60_000)
      handle.unref?.()
      return () => clearInterval(handle)
    }, 'opencode-model-sync periodic sync')
  }
}
