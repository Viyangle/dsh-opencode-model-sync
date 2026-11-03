/**
 * The model-facing manual trigger.
 *
 * The plugin is autonomous (startup + periodic refresh), but network access,
 * credentials, and a just-released model sometimes need a human to say "now".
 * One small tool keeps that action discoverable without a client-side panel.
 *
 * @module dsh-opencode-model-sync/tool
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

const TOOL_NAME = 'opencode_model_sync'

const DESCRIPTION = [
  'Inspect or refresh the OpenCode Go provider routes managed by the opencode-model-sync plugin.',
  'action=status reports the last sync, any error, and the live model count of each generated route.',
  'action=sync fetches the live OpenCode catalog now and writes changed model lists into DSH settings; set dryRun=true to preview.',
  'action=remove deletes the generated routes from the llm-pi-ai settings section.',
  'Use status first when the model picker is missing a model; use sync after a model was published upstream.',
].join(' ')

/** Tool output must be lossless JSON, which rejects `undefined` members. */
function toJsonValue(value) {
  if (Array.isArray(value)) return value.map(toJsonValue)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) out[key] = toJsonValue(entry)
    }
    return out
  }
  return value
}

/**
 * Register the manual tool when the tool registry is available.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {import('./engine.js').SyncEngine} engine - owning engine.
 */
export function registerTool(ctx, engine) {
  const tools = ctx.get('tools')
  if (tools === undefined) return

  ctx.effect(() => tools.register(defineTool({
    name: TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        enum: ['status', 'sync', 'remove'],
        description: 'status (default) reports state, sync refreshes the catalog, remove deletes the generated routes.',
      },
      dryRun: {
        type: 'boolean',
        description: 'With action=sync, compute and report the changes without writing them.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{
        type: 'text',
        text: JSON.stringify(value, null, 2),
      }],
    },
    async execute(args) {
      const action = args?.action ?? 'status'
      try {
        if (action === 'sync') return toJsonValue(await engine.sync({ dryRun: args?.dryRun === true, reason: 'tool' }))
        if (action === 'remove') return toJsonValue(await engine.remove())
        return toJsonValue(await engine.status())
      } catch (error) {
        return {
          ok: false,
          action,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
  })), 'opencode-model-sync tool')
}
