import assert from 'node:assert/strict';
import test from 'node:test';
import { zstdDecompressSync } from 'node:zlib';
import { apply as applyAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { modelEntries, PROVIDER } from '../core.js';
import { installSpeedMode } from '../speed.js';
import { apply as applyPlugin } from '../index.js';
import { SubscriptionClient } from '../client.js';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';

test('speed choices follow catalog tiers, including legacy and future tiers', () => {
  const entries = modelEntries({ models: [
    { slug: 'new', service_tiers: [{ id: 'fast', name: 'Fast' }, { id: 'ultrafast', name: 'Ultrafast' }, { id: 'future', name: 'Future tier' }, { id: 'fast' }, null, { id: '../bad' }] },
    { slug: 'legacy', additional_speed_tiers: ['fast', 'ultrafast'] },
    { slug: 'standard' },
  ] }, true);
  assert.deepEqual(entries[0].speedModes.map(m => m.id), ['default', 'fast', 'ultrafast', 'future']);
  assert.deepEqual(entries[1].speedModes, [{ id: 'default', name: 'Standard' }, { id: 'fast', name: 'Fast' }, { id: 'ultrafast', name: 'Ultra' }]);
  assert.deepEqual(entries[2].speedModes, [{ id: 'default', name: 'Standard' }]);
  assert.equal(modelEntries({ data: [{ id: 'api' }] })[0].speedModes, undefined);
});

test('speed bridge reaches real requests, preserves persona and handles snapshots and disposal', async () => {
  const callbacks = new Map();
  const token = ['fake', Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fake' } })).toString('base64url'), 'fake'].join('.');
  let adapter, config;
  const context = {
    get: name => name === 'credentials' ? { resolve: async () => ({ value: token }) } : undefined,
    inject() {}, on: (name, fn) => callbacks.set(name, fn),
    llm: {
      registerConfigurableProviders() {}, registerModelDiscovery() {},
      registerAdapter(_, value) { adapter = value; }, registration: () => ({ adapter }),
    },
  };
  context.inject = (services, fn) => {
    if (services[0] === 'settings') fn({ settings: { installSection(_, __, ___, initial, hooks) {
      config = initial; hooks.setSource(() => config);
    } } });
  };
  applyAdapter(context, { providers: { [PROVIDER]: { apiKeyEnv: 'TEST_FAKE_KEY', transport: 'sse', models: [
    { id: 'gpt-6.1-sol', contextWindow: 1_050_000, maxTokens: 128_000 },
    { id: 'other-model', contextWindow: 262_144, maxTokens: 32_768 },
  ] } } });
  let mode;
  const originalCurrent = adapter.current;
  installSpeedMode(context, { get: () => ({ modes: mode ? { 'gpt-6.1-sol': mode } : {} }) });
  const originalFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_, init) => {
    const bytes = init.headers.get('content-encoding') === 'zstd' ? zstdDecompressSync(init.body) : init.body;
    bodies.push(JSON.parse(typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString()));
    return new Response('data: ' + JSON.stringify({ type: 'response.completed', response: {
      id: 'resp-test', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 0 },
    } }) + '\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const request = model => ({ provider: PROVIDER, model, messages: [
    { role: 'system', content: [{ type: 'text', text: 'Custom persona must survive.' }] },
    { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
  ] });
  try {
    for (const value of ['fast', 'ultrafast', 'default']) {
      mode = value;
      // Bind a prepared call before replacing the profile to test old snapshots.
      const prepared = await adapter.prepareCall(PROVIDER, 'gpt-6.1-sol');
      config = structuredClone(config);
      for await (const _ of prepared.stream(request('gpt-6.1-sol'))) {}
      assert.equal(bodies.at(-1).service_tier, value);
      assert.equal(bodies.at(-1).instructions, 'Custom persona must survive.');
    }
    for await (const _ of adapter.stream(request('other-model'))) {}
    assert.equal(bodies.at(-1).service_tier, undefined);
    callbacks.get('dispose')();
    assert.equal(adapter.current, originalCurrent);
    for await (const _ of adapter.stream(request('gpt-6.1-sol'))) {}
    assert.equal(bodies.at(-1).service_tier, undefined);
  } finally { globalThis.fetch = originalFetch; }
});

test('speed endpoint discovers tiers, persists per model and rejects unsupported selections', async t => {
  t.mock.method(SubscriptionClient.prototype, 'connected', async () => true);
  t.mock.method(SubscriptionClient.prototype, 'catalog', async () => modelEntries({ models: [
    { slug: 'gpt-6.1-sol', additional_speed_tiers: ['fast'] },
  ] }, true));
  const sections = new Map();
  let handler, models = [];
  const ctx = { credentials: {}, on() {}, llm: {
    registration() { throw Object.assign(new Error('No adapter yet'), { code: 'NO_ADAPTER' }); },
    listModels: async () => models,
  }, settings: {
    register(name, schema) {
      let value = schema({});
      const section = { get: () => value, update: async patch => { value = schema({ ...value, ...patch }); } };
      sections.set(name, section); return section;
    },
    async mutate(name, ops) {
      if (name === 'llm-pi-ai') {
        models = ops.find(op => op.path.at(-1) === 'models').value;
        assert.equal(models[0].speedModes, undefined, 'Adapter model schema receives no UI speed fields');
      } else {
        const section = sections.get(name), value = structuredClone(section.get());
        for (const op of ops) value[op.path[0]][op.path[1]] = op.value;
        await section.update(value);
      }
    },
  }, inject(services, fn) {
    if (services[0] === 'webServer') fn({ webServer: { register(route) { handler = route.handler; } } });
  } };
  applyPlugin(ctx);
  let csrf;
  const request = async (path, data) => {
    const req = Readable.from(data ? [JSON.stringify(data)] : []);
    Object.assign(req, { url: '/codex-subscription' + path, method: data ? 'POST' : 'GET',
      socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost', 'x-codex-ui': '1', 'x-codex-csrf': csrf } });
    const res = new EventEmitter();
    res.setHeader = () => {}; res.writeHead = code => { res.status = code; res.headersSent = true; };
    res.end = text => { res.body = JSON.parse(text); res.writableEnded = true; };
    await handler(req, res); return res;
  };
  csrf = (await request('/bootstrap')).body.csrf;
  const discovered = await request('/speed/settings');
  assert.equal(discovered.status, 200);
  assert.deepEqual(discovered.body.catalog['gpt-6.1-sol'].map(m => m.id), ['default', 'fast']);
  assert.equal((await request('/speed/settings', { model: 'gpt-6.1-sol', mode: 'fast' })).status, 200);
  assert.equal((await request('/speed/settings')).body.modes['gpt-6.1-sol'], 'fast');
  assert.equal((await request('/speed/settings', { model: 'gpt-6.1-sol', mode: 'ultrafast' })).status, 400);
  assert.equal((await request('/speed/settings', { model: 'unlisted', mode: 'fast' })).status, 400);
  assert.equal(sections.get('codex-oauth-speed').get().modes['gpt-6.1-sol'], 'fast');
});
