import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isBundledRouteRetirable, planRoutes, routeForModel } from '../lib/plan.js'

const OPTIONS = { retiredModels: 'drop', excludeModels: [] }

function route(id, api, modelIds, baseURL = 'https://example.test/v1') {
  return {
    id,
    config: {
      api,
      baseURL,
      apiKeyEnv: 'OPENCODE_API_KEY',
      models: modelIds.map(modelId => ({ id: modelId, name: modelId })),
    },
  }
}

function ids(planned, index = 0) {
  return planned[index].config.models.map(model => model.id)
}

test('a fresh route reports every model as added and needs a write', () => {
  const planned = planRoutes([route('r-chat', 'openai-completions', ['a', 'b'])], {}, OPTIONS)
  assert.deepEqual(planned[0].added, ['a', 'b'])
  assert.deepEqual(planned[0].removed, [])
  assert.equal(planned[0].changed, true)
})

test('an identical profile route is not rewritten', () => {
  const live = route('r-chat', 'openai-completions', ['a', 'b'])
  const planned = planRoutes([live], { 'r-chat': structuredClone(live.config) }, OPTIONS)
  assert.equal(planned[0].changed, false)
})

test('keep retains a model that disappeared from the catalog', () => {
  const before = { 'r-chat': { ...route('r-chat', 'openai-completions', ['live', 'old']).config } }
  const planned = planRoutes(
    [route('r-chat', 'openai-completions', ['live'])],
    before,
    { ...OPTIONS, retiredModels: 'keep' },
  )
  assert.deepEqual(ids(planned), ['live', 'old'])
  assert.deepEqual(planned[0].added, [])
  assert.deepEqual(planned[0].removed, [])
})

test('keep never resurrects an excluded model', () => {
  const before = { 'r-chat': { ...route('r-chat', 'openai-completions', ['live', 'banned']).config } }
  const planned = planRoutes(
    [route('r-chat', 'openai-completions', ['live'])],
    before,
    { ...OPTIONS, retiredModels: 'keep', excludeModels: ['banned'] },
  )
  assert.deepEqual(ids(planned), ['live'])
  assert.deepEqual(planned[0].removed, ['banned'])
})

test('keep never duplicates a model that moved to another protocol route', () => {
  const before = {
    'r-chat': { ...route('r-chat', 'openai-completions', ['chat-model', 'moved-model']).config },
    'r-anthropic': { ...route('r-anthropic', 'anthropic-messages', ['moved-model'], 'https://example.test/anthropic').config },
  }
  const planned = planRoutes(
    [
      route('r-chat', 'openai-completions', ['chat-model']),
      route('r-anthropic', 'anthropic-messages', ['moved-model'], 'https://example.test/anthropic'),
    ],
    before,
    { ...OPTIONS, retiredModels: 'keep' },
  )
  assert.deepEqual(ids(planned, 0), ['chat-model'])
  assert.deepEqual(ids(planned, 1), ['moved-model'])
})

test('drop follows the live catalog and reports removed ids', () => {
  const before = { 'r-chat': { ...route('r-chat', 'openai-completions', ['old', 'live']).config } }
  const planned = planRoutes([route('r-chat', 'openai-completions', ['live'])], before, OPTIONS)
  assert.deepEqual(ids(planned), ['live'])
  assert.deepEqual(planned[0].removed, ['old'])
})

test('a same-named provider with another protocol is refused instead of overwritten', () => {
  const before = { 'r-chat': { api: 'anthropic-messages', models: [] } }
  assert.throws(
    () => planRoutes([route('r-chat', 'openai-completions', ['a'])], before, OPTIONS),
    /refusing to overwrite provider "r-chat"/,
  )
})

test('the plugin may evolve its own route even when baseURL changes', () => {
  const before = { 'r-chat': { ...route('r-chat', 'openai-completions', ['a'], 'https://old.test/v1').config } }
  const planned = planRoutes([route('r-chat', 'openai-completions', ['a'], 'https://new.test/v1')], before, OPTIONS)
  assert.equal(planned[0].changed, true)
  assert.equal(planned[0].config.baseURL, 'https://new.test/v1')
})

test('a non-object provider value is refused', () => {
  assert.throws(
    () => planRoutes([route('r-chat', 'openai-completions', ['a'])], { 'r-chat': 'nope' }, OPTIONS),
    /not an object/,
  )
})

test('routeForModel finds the generated route serving a model', () => {
  const routes = [
    route('r-chat', 'openai-completions', ['chat-model']),
    route('r-anthropic', 'anthropic-messages', ['anthropic-model']),
  ]
  assert.equal(routeForModel(routes, 'anthropic-model'), 'r-anthropic')
  assert.equal(routeForModel(routes, 'missing'), undefined)
})

test('only the untouched bundled provider profile may be retired', () => {
  assert.equal(isBundledRouteRetirable({}), true)
  assert.equal(isBundledRouteRetirable({ apiKeyEnv: 'OPENCODE_API_KEY' }), false)
  assert.equal(isBundledRouteRetirable({ models: [] }), false)
  assert.equal(isBundledRouteRetirable(null), false)
  assert.equal(isBundledRouteRetirable([]), false)
  assert.equal(isBundledRouteRetirable('opencode-go'), false)
})
