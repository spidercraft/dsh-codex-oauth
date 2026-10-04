import assert from 'node:assert/strict';
import test from 'node:test';
import { SubscriptionClient } from '../client.js';
import { apply as applyAdapter } from '@deepseek-ai/dsh-llm-pi-ai';

const releaseURL = 'https://registry.npmjs.org/@openai%2fcodex/latest';
const catalog = { models: [
  { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', context_window: 1_050_000,
    max_output_tokens: 128_000, input_modalities: ['text', 'image'],
    supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }, { effort: 'max' }] },
  { slug: 'future-model', display_name: 'Future model', context_window: 400_000,
    supported_reasoning_levels: [{ effort: 'high' }] },
] };

test('refresh follows new releases and serves models absent from the installed adapter', async () => {
  let version = '0.160.0';
  const calls = [];
  const client = new SubscriptionClient({}, async (url, init) => {
    calls.push({ url, init });
    if (url === releaseURL) return Response.json({ version });
    assert.equal(new URL(url).searchParams.get('client_version'), version);
    return Response.json(catalog);
  });
  client.models.getAuth = async () => ({ auth: { apiKey: 'fake-account-token' } });
  for (const nextVersion of ['0.160.0', '0.200.0']) {
    version = nextVersion;
    const entries = await client.catalog();
    assert.deepEqual(entries.map(m => m.id), ['gpt-6.1-sol', 'future-model']);
    let adapter;
    applyAdapter({ get: () => undefined, inject() {}, llm: {
      registerConfigurableProviders() {}, registerModelDiscovery() {},
      registerAdapter(_, value) { adapter = value; },
    } }, { providers: { 'openai-codex': { models: entries } } });
    assert.deepEqual((await adapter.listModels('openai-codex')).map(m => m.id), entries.map(m => m.id));
    const sol = await adapter.resolveModel('openai-codex', 'gpt-6.1-sol');
    assert.equal(sol.context.contextWindow, 1_050_000);
    assert.ok(sol.reasoning.efforts.some(e => e.id === 'max'));
    const future = await adapter.resolveModel('openai-codex', 'future-model');
    assert.equal(future.context.contextWindow, 400_000);
    assert.deepEqual(future.reasoning.efforts.map(e => e.id), ['high']);
  }
  assert.equal(calls.filter(c => c.url === releaseURL).length, 2);
  for (const { url, init } of calls) {
    assert.equal(init.cache, 'no-store');
    if (url === releaseURL) assert.equal(init.headers.Authorization, undefined);
    else assert.equal(init.headers.Authorization, 'Bearer fake-account-token');
  }
});

test('release discovery errors never request an old catalog or expose upstream bodies', async () => {
  for (const response of [new Response('private-upstream-body', { status: 503 }),
    new Response('invalid-json'), Response.json({}), Response.json({ version: '0.160.0&other=1' })]) {
    const client = new SubscriptionClient({}, async () => response);
    client.request = () => assert.fail('Failed discovery must preserve the existing catalog');
    await assert.rejects(client.catalog(), {
      message: 'OpenAI model discovery could not check the latest Codex release. Existing models were preserved; check your connection and retry.',
    });
  }
});

test('release lookup cancellation propagates to the fetch and prevents catalog requests', async () => {
  const controller = new AbortController();
  controller.abort();
  const client = new SubscriptionClient({}, async (_, { signal }) => signal.throwIfAborted());
  client.request = () => assert.fail('Cancelled discovery must not fetch models');
  await assert.rejects(client.catalog(controller.signal), { name: 'AbortError' });
});
