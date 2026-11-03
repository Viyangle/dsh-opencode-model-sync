import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildRoutes,
  inputModalitiesOf,
  modelEntryOf,
  reasoningEffortsOf,
  routeBaseUrl,
  routeIdsFor,
} from '../lib/catalog.js'

const OPTIONS = {
  routePrefix: 'opencode-go',
  displayNamePrefix: 'OpenCode Go',
  apiKeyEnv: 'OPENCODE_API_KEY',
  sessionId: '00000000-0000-7000-8000-000000000000',
  excludeModels: [],
}

function record(id, protocol, baseUrl, extra = {}) {
  return {
    id,
    type: 'chat',
    name: id,
    limit: { context: 100000, output: 2000 },
    modalities: { input: ['text'] },
    capabilities: { reasoning: { supported: false } },
    api: { [protocol]: { base_url: baseUrl } },
    ...extra,
  }
}

test('groups one route per supported protocol and keeps catalog order-independent ids', () => {
  const built = buildRoutes({
    data: [
      record('zeta', 'chat-completions', 'https://example.test/openai/v1'),
      record('alpha', 'chat-completions', 'https://example.test/openai/v1'),
      record('claude', 'messages', 'https://example.test/anthropic/v1'),
      record('gpt', 'responses', 'https://example.test/openai/v1'),
    ],
  }, OPTIONS)

  assert.deepEqual(built.routes.map(route => route.id), [
    'opencode-go-chat',
    'opencode-go-anthropic',
    'opencode-go-responses',
  ])
  assert.deepEqual(built.routes[0].config.models.map(model => model.id), ['alpha', 'zeta'])
  assert.equal(built.routes[0].config.api, 'openai-completions')
  assert.equal(built.routes[0].config.displayName, 'OpenCode Go · Chat Completions')
  assert.deepEqual(built.routes[0].config.headers, { 'x-opencode-session': OPTIONS.sessionId })
  assert.deepEqual(built.routes[0].config.compat, { thinkingFormat: 'deepseek' })
  assert.equal(built.routes[1].config.compat, undefined)
  assert.equal(built.modelCount, 4)
})

test('skips protocols DSH cannot serve and reports why', () => {
  const built = buildRoutes({
    data: [
      record('gemini', 'generate-content', 'https://example.test/google/v1beta'),
      record('kimi', 'chat-completions', 'https://example.test/openai/v1'),
    ],
  }, OPTIONS)

  assert.equal(built.routes.length, 1)
  assert.deepEqual(built.skipped, [{ id: 'gemini', reason: 'unsupported-api:generate-content' }])
})

test('honors excludeModels and non-chat records', () => {
  const built = buildRoutes({
    data: [
      record('kimi', 'chat-completions', 'https://example.test/openai/v1'),
      record('banned', 'chat-completions', 'https://example.test/openai/v1'),
      record('embed', 'chat-completions', 'https://example.test/openai/v1', { type: 'embedding' }),
    ],
  }, { ...OPTIONS, excludeModels: ['banned'] })

  assert.deepEqual(built.routes[0].config.models.map(model => model.id), ['kimi'])
  assert.deepEqual(built.skipped.map(entry => entry.reason).sort(), ['excluded', 'unsupported-type:embedding'])
})

test('maps modalities to the DSH image capability', () => {
  assert.deepEqual(inputModalitiesOf({ modalities: { input: ['text', 'image/png'] } }), ['text', 'image'])
  assert.deepEqual(inputModalitiesOf({ modalities: { input: ['text'] } }), ['text'])
  assert.deepEqual(inputModalitiesOf({}), ['text'])
})

test('maps reasoning levels, including the none → off alias', () => {
  assert.deepEqual(
    reasoningEffortsOf({ capabilities: { reasoning: { supported: true, effort: ['none', 'low', 'high'] } } }),
    { off: null, low: 'low', high: 'high' },
  )
  assert.deepEqual(
    reasoningEffortsOf({ capabilities: { reasoning: { supported: true, effort: ['minimal', 'max'] } } }),
    { minimal: 'minimal', max: 'max' },
  )
  assert.equal(reasoningEffortsOf({ capabilities: { reasoning: { supported: false } } }), false)
  assert.equal(reasoningEffortsOf({ capabilities: { reasoning: { supported: true, effort: [] } } }), undefined)
  assert.equal(reasoningEffortsOf({}), undefined)
})

test('falls back to DSH defaults for missing limits', () => {
  const entry = modelEntryOf({ id: 'plain', name: '', modalities: {}, capabilities: {} })
  assert.equal(entry.contextWindow, 262144)
  assert.equal(entry.maxTokens, 32768)
  assert.equal(entry.name, 'plain')
  assert.equal(entry.reasoningEfforts, undefined)
})

test('drops models whose protocol base_url is unusable', () => {
  const built = buildRoutes({
    data: [
      record('ok', 'chat-completions', 'https://example.test/openai/v1'),
      record('broken', 'chat-completions', 'not-a-url'),
    ],
  }, OPTIONS)

  assert.deepEqual(built.routes[0].config.models.map(model => model.id), ['ok'])
  assert.equal(built.warnings.length, 1)
  assert.match(built.warnings[0], /broken/)
})

test('uses the dominant base URL and warns about a split', () => {
  const built = buildRoutes({
    data: [
      record('one', 'chat-completions', 'https://a.test/v1'),
      record('two', 'chat-completions', 'https://a.test/v1'),
      record('three', 'chat-completions', 'https://b.test/v1'),
    ],
  }, OPTIONS)

  assert.equal(built.routes[0].config.baseURL, 'https://a.test/v1')
  assert.equal(built.warnings.length, 1)
  assert.match(built.warnings[0], /different base URLs/)
})

test('strips /v1 from Anthropic bases but keeps it for the OpenAI SDK protocols', () => {
  const built = buildRoutes({
    data: [
      record('claude', 'messages', 'https://example.test/anthropic/v1'),
      record('gpt', 'responses', 'https://example.test/openai/v1'),
      record('kimi', 'chat-completions', 'https://example.test/openai/v1'),
    ],
  }, OPTIONS)

  assert.equal(built.routes[1].config.baseURL, 'https://example.test/anthropic')
  assert.equal(built.routes[2].config.baseURL, 'https://example.test/openai/v1')
  assert.equal(built.routes[0].config.baseURL, 'https://example.test/openai/v1')
  assert.equal(routeBaseUrl({ api: 'anthropic-messages' }, 'https://example.test/anthropic/v1/'), 'https://example.test/anthropic')
  assert.equal(routeBaseUrl({ api: 'anthropic-messages' }, 'https://example.test/anthropic'), 'https://example.test/anthropic')
  assert.equal(routeBaseUrl({ api: 'openai-completions' }, 'https://example.test/openai/v1/'), 'https://example.test/openai/v1')
})

test('route ids follow the configured prefix and routeIdsFor stays in sync', () => {
  const options = { ...OPTIONS, routePrefix: 'My OpenCode!' }
  assert.deepEqual(routeIdsFor(options), ['my-opencode-chat', 'my-opencode-anthropic', 'my-opencode-responses'])
  assert.equal(buildRoutes({
    data: [record('kimi', 'chat-completions', 'https://example.test/openai/v1')],
  }, options).routes[0].id, 'my-opencode-chat')
})

test('rejects a malformed catalog payload', () => {
  assert.throws(() => buildRoutes({ data: {} }, OPTIONS), /"data" array/)
  assert.throws(() => buildRoutes(null, OPTIONS), /"data" array/)
})

test('rejects a session id that cannot be an HTTP header', () => {
  assert.throws(
    () => buildRoutes({ data: [] }, { ...OPTIONS, sessionId: 'bad\nvalue' }),
    /control characters/,
  )
})
