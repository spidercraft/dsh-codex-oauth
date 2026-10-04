import { createModels } from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { recordKeyFor } from '@deepseek-ai/dsh-llm-pi-ai';
import { attributionHeaders } from '@deepseek-ai/dsh-llm';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { randomUUID } from 'node:crypto';
import { BASE, PROVIDER, accountId, checked, modelEntries, usageSummary } from './core.js';

// Share the adapter's credential record, including its cross-process refresh lock.
// Tokens stay in DSH's credential service and never cross the browser boundary.
export function credentialStore(credentials) {
  const key = recordKeyFor(PROVIDER);
  const payload = record => record?.kind === 'grant' ? record.payload : undefined;
  return {
    read: async () => payload(await credentials.readRecord(key)),
    list: async () => (await credentials.readRecord(key)) ? [{ providerId: PROVIDER, type: 'oauth' }] : [],
    modify: async (_, mutate) => payload(await credentials.modifyRecord(key, async current => {
      const next = await mutate(payload(current));
      return next ? { kind: 'grant', payload: JSON.parse(JSON.stringify(next)) } : undefined;
    })),
    delete: () => credentials.deleteRecord(key),
  };
}

export class SubscriptionClient {
  constructor(credentials, fetcher = fetch) {
    this.credentials = credentials;
    this.fetch = fetcher;
    this.store = credentialStore(credentials);
    this.models = createModels({ credentials: this.store, authContext: { env: async () => undefined, fileExists: async () => false } });
    this.models.setProvider(openaiCodexProvider());
  }

  async request(path, init = {}) {
    let result;
    try { result = await this.models.getAuth(PROVIDER, { signal: init.signal }); }
    catch { throw new Error('Sign in with ChatGPT again; refreshing the stored session failed.'); }
    if (!result?.auth.apiKey) throw new Error('Sign in with ChatGPT first.');
    const token = result.auth.apiKey;
    const id = accountId(token);
    const headers = { ...attributionHeaders(), ...result.auth.headers,
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      'OpenAI-Beta': 'responses=experimental', originator: 'codex_cli_rs',
      ...(id ? { 'ChatGPT-Account-Id': id } : {}), ...init.headers };
    const signal = AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(init.method === 'POST' ? 600_000 : 30_000)]);
    return checked(await this.fetch(`${BASE}${path}`, { ...init, headers, signal, redirect: 'error' }));
  }

  async usage(signal) { return usageSummary(await (await this.request('/wham/usage', { signal })).json()); }
  async catalog(signal) {
    // The subscription catalog is gated by client version. Resolve the published
    // release on every refresh so new models don't require a plugin update.
    let version;
    try {
      const response = await this.fetch('https://registry.npmjs.org/@openai%2fcodex/latest', {
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]),
        headers: { Accept: 'application/json' }, cache: 'no-store', redirect: 'error',
      });
      if (!response.ok) throw new Error('Release lookup failed.');
      ({ version } = await response.json());
      if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release version.');
    } catch {
      signal?.throwIfAborted();
      throw new Error('OpenAI model discovery could not check the latest Codex release. Existing models were preserved; check your connection and retry.');
    }
    return modelEntries(await (await this.request(`/codex/models?client_version=${version}`, { signal, cache: 'no-store' })).json(), true);
  }
  async connected() { return Boolean(await this.store.read()); }
  async logout() { await this.models.logout(PROVIDER); }

  async apiRequest(path, init = {}) {
    const key = (await this.credentials.resolve(credentialRef('DSH_OPENAI_API_KEY')))?.value;
    if (!key) throw new Error('Sign in with an optional OpenAI API key first.');
    return checked(await this.fetch(`https://api.openai.com/v1${path}`, { ...init, redirect: 'error',
      signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(600_000)]),
      headers: { ...attributionHeaders(), Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    }));
  }

  async apiModels(signal) {
    const raw = await (await this.apiRequest('/models', { signal })).json();
    return modelEntries(raw);
  }

  async generate({ prompt, model, source = 'subscription', size = 'auto', quality = 'auto' }, signal) {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 32000) throw new Error('Enter an image prompt between 1 and 32,000 characters.');
    if (typeof model !== 'string' || !/^[a-zA-Z0-9._:-]{1,200}$/.test(model)) throw new Error('Choose a valid model.');
    if (!['auto', '1024x1024', '1536x1024', '1024x1536'].includes(size)) throw new Error('Invalid image size.');
    if (!['auto', 'low', 'medium', 'high'].includes(quality)) throw new Error('Invalid image quality.');
    if (!['subscription', 'api'].includes(source)) throw new Error('Invalid image connection.');
    if (source === 'api') {
      if (!/^(gpt-image|chatgpt-image)/.test(model)) throw new Error('Choose a valid GPT Image model for API image generation.');
      const raw = await (await this.apiRequest('/images/generations', { method: 'POST', signal,
        body: JSON.stringify({ model, prompt, size, quality, n: 1, output_format: 'png' }),
      })).json();
      if (!raw.data?.length || raw.data.some(i => typeof i.b64_json !== 'string' || !i.b64_json)) throw new Error('OpenAI returned no image bytes.');
      return raw.data.map(i => ({ data: i.b64_json, format: 'png' }));
    }
    const response = await this.request('/codex/images/generations', { method: 'POST', signal,
      headers: { 'x-codex-image-turn-id': randomUUID() },
      body: JSON.stringify({ model, prompt, size, quality, background: 'auto', n: 1 }),
    });
    const raw = await response.json();
    if (!raw.data?.length || raw.data.some(i => typeof i.b64_json !== 'string' || !i.b64_json)) throw new Error('OpenAI returned no image bytes.');
    return raw.data.map(i => ({ data: i.b64_json, format: 'png' }));
  }
}
