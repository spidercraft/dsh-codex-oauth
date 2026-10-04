import { PROVIDER } from './core.js';

export function installSpeedMode(ctx, settings) {
  const adapters = new Map(), providers = new WeakSet();
  let active = true;
  const install = () => {
    let adapter;
    try { adapter = ctx.llm.registration(PROVIDER).adapter; }
    catch (error) { if (error.code === 'NO_ADAPTER') return; throw error; }
    if (adapters.has(adapter)) return;
    // ponytail: DSH 0.1.5-rc.2 has no serviceTier setting. Wrap its snapshot's
    // provider options; replace this bridge when DSH exposes the native knob.
    if (typeof adapter.current !== 'function') throw new Error('OpenAI speed control requires the supported DSH pi-ai adapter.');
    const original = adapter.current;
    const wrapped = function () {
      const snapshot = original.call(this);
      const provider = snapshot.models.getProvider(PROVIDER);
      if (provider && !providers.has(provider)) {
        providers.add(provider);
        for (const method of ['stream', 'streamSimple']) {
          const stream = provider[method];
          provider[method] = (model, context, options) => {
            const tier = active ? settings.get().modes[model.id] : undefined;
            // pi-ai's streamSimple drops provider-specific options, but preserves
            // onPayload for both SSE and WebSocket request construction.
            return stream.call(provider, model, context, tier ? { ...options, onPayload: async (body, requestModel) => {
              const next = await options?.onPayload?.(body, requestModel) ?? body;
              return { ...next, service_tier: tier };
            } } : options);
          };
        }
      }
      return snapshot;
    };
    adapters.set(adapter, { original, wrapped });
    adapter.current = wrapped;
  };
  ctx.on('llm/adapters-updated', install);
  ctx.on('dispose', () => {
    active = false;
    for (const [adapter, { original, wrapped }] of adapters) if (adapter.current === wrapped) adapter.current = original;
  });
  install();
}
