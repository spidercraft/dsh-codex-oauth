import { randomBytes } from 'node:crypto';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all';
import { SubscriptionClient } from './client.js';
import { PROVIDER, localRequest } from './core.js';
import { installSpeedMode } from './speed.js';

export const name = 'codex-oauth';
export const inject = ['llm', 'credentials', 'settings'];
const ROOT = '/codex-subscription';

export function apply(ctx) {
  const client = new SubscriptionClient(ctx.credentials);
  const speedSettings = ctx.settings.register('codex-oauth-speed', z.object({
    modes: z.dict(z.string()).default({}),
    catalog: z.dict(z.array(z.object({ id: z.string(), name: z.string() }))).default({}),
  }));
  installSpeedMode(ctx, speedSettings);
  const imageSettings = ctx.settings.register('codex-oauth-images', z.object({
    source: z.union(['subscription', 'api']).default('subscription'),
    model: z.string().default('gpt-image-2'),
  }));
  const csrf = randomBytes(32).toString('hex');
  let login = { state: 'idle' };
  let loginController, answerPrompt, loginTask;
  const lifetime = new AbortController();
  ctx.on('dispose', async () => {
    lifetime.abort(); loginController?.abort();
    await loginTask;
  });

  async function syncModels(signal) {
    const catalog = await client.catalog(signal);
    const models = catalog.map(({ speedModes, ...model }) => model);
    if (!models.length) throw new Error('OpenAI returned an empty model catalog; existing choices were preserved.');
    await ctx.settings.mutate('llm-pi-ai', [
      { op: 'unset', path: ['providers', PROVIDER, 'modelOverrides'] },
      { op: 'set', path: ['providers', PROVIDER, 'models'], value: models },
    ]);
    await speedSettings.update({ catalog: Object.fromEntries(catalog.map(m => [m.id, m.speedModes])) });
    return models;
  }

  function startLogin() {
    if (login.state === 'pending') return login;
    loginController = new AbortController();
    const signal = AbortSignal.any([loginController.signal, lifetime.signal, AbortSignal.timeout(15 * 60_000)]);
    login = { state: 'pending', notice: 'Starting sign-in…' };
    loginTask = client.models.login(PROVIDER, 'oauth', {
      signal,
      notify(event) {
        login.notice = event.instructions ?? event.message ?? 'Continue sign-in in your browser.';
        if (event.url || event.verificationUri) login.url = event.url ?? event.verificationUri;
        if (event.userCode) login.code = event.userCode;
      },
      prompt(prompt) {
        const promptSignal = prompt.signal ? AbortSignal.any([signal, prompt.signal]) : signal;
        return new Promise((resolve, reject) => {
          const abort = () => finish(new Error('Sign-in prompt cancelled.'));
          const finish = (error, value) => {
            promptSignal.removeEventListener('abort', abort);
            answerPrompt = undefined; delete login.prompt;
            error ? reject(error) : resolve(value);
          };
          if (promptSignal.aborted) return reject(new Error('Sign-in cancelled.'));
          login.prompt = { type: prompt.type, message: prompt.message, options: prompt.options ?? [] };
          answerPrompt = value => finish(null, value);
          promptSignal.addEventListener('abort', abort, { once: true });
        });
      },
    }).then(async () => {
      login = { state: 'complete', notice: 'Connected to your ChatGPT subscription.' };
      try { await syncModels(signal); } catch { login.notice += ' Refresh the model list to retry discovery.'; }
    }).catch(() => {
      // Provider OAuth errors can contain token response bodies. Never return those to the browser.
      login = { state: 'failed', notice: 'Sign-in failed or was cancelled. Retry, or choose device-code sign-in if the callback port is busy.' };
    });
    return login;
  }

  async function generate(args, signal) {
    const attachments = ctx.get('attachments');
    if (!attachments) throw new Error('The DSH attachment service is required to save generated images.');
    // The saved selection owns routing, including billing; the chat model cannot override it.
    const images = await client.generate({ prompt: args.prompt, size: args.size, quality: args.quality, ...imageSettings.get() }, signal);
    const saved = [];
    for (const image of images) {
      signal?.throwIfAborted();
      if (image.format !== 'png') throw new Error('OpenAI returned an unexpected image format.');
      saved.push(await attachments.saveImage({ data: Buffer.from(image.data, 'base64'), mediaType: 'image/png', name: 'generated.png' }));
    }
    return saved;
  }

  async function imageModels(source, signal) {
    if (source === 'subscription') return { connected: await client.connected(), models: [{ id: 'gpt-image-2', name: 'GPT Image 2' }] };
    if (source !== 'api') throw new Error('Invalid image connection.');
    const connected = (await ctx.credentials.describe(credentialRef('DSH_OPENAI_API_KEY'))).configured;
    return { connected, models: connected ? (await client.apiModels(signal)).filter(m => /^(gpt-image|chatgpt-image)/.test(m.id)) : [] };
  }

  ctx.inject(['tools'], toolsCtx => {
    toolsCtx.tools.register(defineTool({
      name: 'openai_subscription_usage',
      description: 'Read remaining ChatGPT subscription usage percentages and reset times, including five-hour and weekly limits when available.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_, text) => [{ type: 'text', text }] },
      execute: async (_, exec) => JSON.stringify(await client.usage(exec.signal), null, 2),
    }));
    toolsCtx.tools.register(defineTool({
      name: 'openai_generate_image',
      description: 'Use this tool whenever the user asks to create or generate an image in normal chat. Return the generated image inline. The image model and connection are already chosen in Settings → OpenAI Connect; do not ask the user to choose them again. Settings control whether subscription or separately billed API access is used. Never switch models or connections on failure.',
      parameters: {
        prompt: { type: 'string', required: true, description: 'Describe the image to generate.' },
        size: { type: 'string', enum: ['auto', '1024x1024', '1536x1024', '1024x1536'] },
        quality: { type: 'string', enum: ['auto', 'low', 'medium', 'high'] },
      },
      timeoutMs: 600_000,
      output: {
        schema: { type: 'string' },
        render: (_, json) => JSON.parse(json).map(attachment => ({ type: 'image', attachment })),
      },
      execute: async (args, exec) => JSON.stringify(await generate(args, exec.signal)),
    }));
  });

  ctx.inject(['webServer'], web => {
    web.webServer.register({ kind: 'prefix', path: ROOT, async handler(req, res) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      const reply = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (!localRequest(req)) return reply(403, { error: 'Open this panel on localhost.' });
      const path = new URL(req.url, 'http://localhost').pathname.slice(ROOT.length);
      if (req.method === 'GET' && path === '/bootstrap' && req.headers['x-codex-ui'] === '1') {
        return reply(200, { csrf });
      }
      if (req.headers['x-codex-csrf'] !== csrf) return reply(403, { error: 'Reload the subscription panel.' });
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, lifetime.signal]);
      res.on('close', () => { if (!res.writableEnded) controller.abort(); });
      try {
        if (req.method === 'GET' && path === '/status') return reply(200, { connected: await client.connected(), apiConnected: (await ctx.credentials.describe(credentialRef('DSH_OPENAI_API_KEY'))).configured, login });
        if (req.method === 'GET' && path === '/usage') return reply(200, await client.usage(signal));
        if (req.method === 'GET' && path === '/models') return reply(200, await ctx.llm.listModels(PROVIDER));
        if (req.method === 'GET' && path === '/speed/settings') {
          if (!Object.keys(speedSettings.get().catalog).length && await client.connected()) await syncModels(signal);
          return reply(200, speedSettings.get());
        }
        if (req.method === 'GET' && path === '/api/models') return reply(200, await client.apiModels(signal));
        if (req.method === 'GET' && path === '/image/settings') return reply(200, imageSettings.get());
        if (req.method === 'GET' && path === '/image/models') {
          const source = new URL(req.url, 'http://localhost').searchParams.get('source');
          return reply(200, await imageModels(source, signal));
        }
        if (req.method !== 'POST') return reply(404, { error: 'Not found.' });
        let input = '';
        for await (const chunk of req) {
          input += chunk;
          if (Buffer.byteLength(input) > 128_000) return reply(413, { error: 'Request too large.' });
        }
        let data;
        try { data = JSON.parse(input || '{}'); } catch { return reply(400, { error: 'Invalid JSON.' }); }
        if (!data || typeof data !== 'object' || Array.isArray(data)) return reply(400, { error: 'Expected an object.' });
        if (path === '/speed/settings') {
          const models = await ctx.llm.listModels(PROVIDER);
          const saved = speedSettings.get();
          const modes = saved.catalog[data.model] ?? [{ id: 'default', name: 'Standard' }];
          if (!models.some(m => m.id === data.model) || !modes.some(m => m.id === data.mode)) return reply(400, { error: 'Choose a listed model and speed mode.' });
          await ctx.settings.mutate('codex-oauth-speed', [{ op: 'set', path: ['modes', data.model], value: data.mode }]);
          return reply(200, speedSettings.get());
        }
        if (path === '/image/settings') {
          const { models } = await imageModels(data.source, signal);
          if (!models.some(m => m.id === data.model)) return reply(400, { error: 'Choose a valid image model from the list.' });
          await imageSettings.update({ source: data.source, model: data.model });
          return reply(200, imageSettings.get());
        }
        if (path === '/login') return reply(200, startLogin());
        if (path === '/login/cancel') {
          loginController?.abort(); await loginTask; login = { state: 'idle' };
          return reply(200, { ok: true });
        }
        if (path === '/login/answer') {
          if (!answerPrompt || typeof data.value !== 'string') return reply(400, { error: 'No sign-in question is waiting.' });
          if (login.prompt?.type === 'select' && !login.prompt.options.some(o => o.id === data.value)) return reply(400, { error: 'Invalid sign-in option.' });
          answerPrompt(data.value); return reply(200, { ok: true });
        }
        if (path === '/logout') {
          loginController?.abort(); await loginTask; await client.logout(); login = { state: 'idle' };
          return reply(200, { ok: true });
        }
        if (path === '/models/refresh') return reply(200, await syncModels(signal));
        if (path === '/api/key') {
          if (typeof data.key !== 'string' || !/^[!-~]{10,500}$/.test(data.key.trim())) return reply(400, { error: 'Enter a valid API key.' });
          await ctx.credentials.set(credentialRef('DSH_OPENAI_API_KEY'), data.key.trim());
          await ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'openai', 'apiKeyEnv'], value: 'DSH_OPENAI_API_KEY' }]);
          return reply(200, { ok: true });
        }
        if (path === '/api/models/refresh') {
          // The models endpoint doesn't report capabilities. Keep DSH's protocol/catalog
          // knowledge and expose explicit manual model entry through its Models settings.
          const available = new Set((await client.apiModels(signal)).map(m => m.id));
          const catalog = getBuiltinModels('openai');
          const models = catalog.filter(m => available.has(m.id)).map(m => ({ id: m.id, name: m.name }));
          if (!models.length) throw new Error('OpenAI returned no chat models recognized by the installed adapter. Update DSH or add the model in Settings → Models.');
          await ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'openai', 'models'], value: models }]);
          return reply(200, models);
        }
        if (path === '/api/disconnect') {
          await ctx.credentials.unset(credentialRef('DSH_OPENAI_API_KEY'));
          return reply(200, { ok: true });
        }
        if (path === '/model') {
          const models = await ctx.llm.listModels(PROVIDER);
          if (!models.some(m => m.id === data.model)) return reply(400, { error: 'Choose a listed model.' });
          await ctx.settings.mutate('agent-default-model', [
            { op: 'set', path: ['provider'], value: PROVIDER },
            { op: 'set', path: ['model'], value: data.model },
            { op: 'unset', path: ['reasoningEffort'] },
          ]);
          return reply(200, { ok: true });
        }
        return reply(404, { error: 'Not found.' });
      } catch (error) {
        // Only our controlled errors may go to the browser; auth-library errors are redacted.
        const message = /^(OpenAI |Sign in |Enter an image |Choose a valid |Invalid image |Image generation |The DSH )/.test(error.message) ? error.message : 'The operation failed. Check your connection and sign-in, then retry.';
        if (!res.headersSent && !res.destroyed) reply(400, { error: message });
      }
    } });
  });
}
