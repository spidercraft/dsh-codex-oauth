// DSH's client-module format. React and primitives come from the host's shared UI.
window.__ModuleLoader__.load({
  id: 'dsh-codex-oauth',
  factory(require) {
    const { createElement: h, useState, useEffect, useRef, useCallback, useSyncExternalStore } = require('react');
    const { Button, Input, Menu, Tag, IconChevronDownOutline14 } = require('@deepseek-ai/dsh-client-ui-primitives');

    function Choice({ label, value, options, onChange, disabled }) {
      const [open, setOpen] = useState(false);
      return h(Menu, { open, onClose: () => setOpen(false), portal: true,
        items: options.map(o => ({ id: o.id, label: o.name ?? o.label ?? o.id })), selectedId: value,
        onSelect: id => { onChange(id); setOpen(false); },
        anchor: h(Button, { variant: 'outline', disabled, 'aria-label': label, 'aria-haspopup': 'menu', 'aria-expanded': open,
          onClick: () => setOpen(!open) }, options.find(o => o.id === value)?.name ?? options.find(o => o.id === value)?.label ?? (value || 'Choose…'), h(IconChevronDownOutline14)),
      });
    }

    const css = `
      .dsh-openai{color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
      .dsh-openai h2,.dsh-openai h3{font-size:16px;line-height:24px;font-weight:500;margin:0 0 8px}
      .dsh-openai p{margin:6px 0 12px}.dsh-openai small,.dsh-openai .muted{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
      .dsh-openai .section{padding:20px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}.dsh-openai .section:first-of-type{padding-top:0}
      .dsh-openai .row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.dsh-openai .spread{justify-content:space-between}.dsh-openai .field{display:flex;flex-direction:column;gap:6px;margin:12px 0;min-width:0}
      .dsh-openai .limits{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:14px 0}.dsh-openai .limit{padding:14px;border-radius:12px;background:var(--dsw-alias-bg-module-platform)}
      .dsh-openai .amount{font-size:24px;line-height:32px;margin:6px 0}.dsh-openai progress{width:100%;height:6px;accent-color:var(--dsw-alias-label-primary)}
      .dsh-openai .notice{color:var(--dsw-alias-state-warn-label);white-space:pre-wrap}.dsh-openai a{color:var(--dsw-alias-label-primary);text-decoration:underline}
      .dsh-openai details>summary{cursor:pointer;font-weight:500}
    `;

    function Limit({ label, window }) {
      return h('div', { className: 'limit' }, h('small', null, label),
        h('div', { className: 'amount' }, window?.remainingPercent == null ? 'Unavailable' : `${Math.round(window.remainingPercent)}% left`),
        window?.remainingPercent != null && h('progress', { max: 100, value: window.remainingPercent, 'aria-label': `${label} remaining` }),
        h('small', null, window?.resetsAt ? `Resets ${new Date(window.resetsAt * 1000).toLocaleString()}` : 'Reset time unavailable'));
    }

    function OpenAISettings() {
      const [status, setStatus] = useState(null), [usage, setUsage] = useState(null);
      const [answer, setAnswer] = useState(''), [apiKey, setApiKey] = useState('');
      const [message, setMessage] = useState(''), [busy, setBusy] = useState('');
      const runtime = useRef(null), connected = useRef(false), loginState = useRef('');

      const request = useCallback(async (path, body, signal) => {
        const current = runtime.current;
        if (!current) throw Error('Settings are still loading.');
        const { csrf } = await current.bootstrap;
        const response = await fetch('/codex-subscription' + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { 'X-Codex-CSRF': csrf, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: signal ? AbortSignal.any([signal, current.controller.signal]) : current.controller.signal,
        });
        const data = await response.json();
        if (!response.ok) throw Error(data.error ?? 'Request failed.');
        return data;
      }, []);
      const loadUsage = useCallback(async () => setUsage(await request('/usage')), [request]);
      const loadStatus = useCallback(async () => {
        const next = await request('/status'); setStatus(next); loginState.current = next.login.state;
        const justConnected = next.connected && !connected.current; connected.current = next.connected;
        if (!next.connected) setUsage(null);
        if (justConnected) await loadUsage();
        return next;
      }, [request, loadUsage]);
      const report = useCallback(error => { if (error.name !== 'AbortError') setMessage(error.message); }, []);
      const run = (name, fn) => async () => {
        setBusy(name); setMessage('');
        try { await fn(); } catch (error) { report(error); } finally { setBusy(''); }
      };

      useEffect(() => {
        const controller = new AbortController();
        runtime.current = { controller, bootstrap: fetch('/codex-subscription/bootstrap', { headers: { 'X-Codex-UI': '1' }, signal: controller.signal }).then(async response => {
          if (!response.ok) throw Error('Open DSH on localhost to manage the OpenAI connection.');
          return response.json();
        }) };
        loadStatus().catch(report);
        let polling = false;
        const loginTimer = setInterval(async () => {
          if (document.hidden || loginState.current !== 'pending' || polling) return;
          polling = true; try { await loadStatus(); } catch (e) { report(e); } finally { polling = false; }
        }, 2000);
        const usageTimer = setInterval(() => { if (!document.hidden && connected.current) loadUsage().catch(report); }, 60000);
        return () => { controller.abort(); clearInterval(loginTimer); clearInterval(usageTimer); };
      }, [loadStatus, loadUsage, report]);
      useEffect(() => { setAnswer(status?.login.prompt?.options?.[0]?.id ?? ''); }, [status?.login.prompt?.message]);

      const button = (title, name, fn, props = {}) => h(Button, { variant: 'outline', size: 'sm', disabled: Boolean(busy) || !status, onClick: run(name, fn), ...props }, busy === name ? 'Working…' : title);
      const field = (label, id, control) => h('div', { className: 'field' }, h('label', { htmlFor: id }, label), control);
      const input = (id, value, setter, props = {}) => h(Input, { id, value, onChange: e => setter(e.target.value), ...props });
      const login = status?.login;
      let loginUrl;
      try { const url = new URL(login?.url); if (url.protocol === 'https:' && url.hostname === 'auth.openai.com') loginUrl = url.href; } catch {}

      return h('div', { className: 'dsh-openai' }, h('style', null, css),
        h('h2', null, 'OpenAI Connect'),
        message && h('p', { className: 'notice', role: 'status', 'aria-live': 'polite' }, message),
        h('section', { className: 'section' },
          h('div', { className: 'row spread' }, h('p', null, 'ChatGPT subscription'), h(Tag, null, !status ? 'Loading…' : status.connected ? 'Connected' : 'Not connected')),
          h('p', { className: 'muted' }, 'Use your ChatGPT subscription for chat and images.'),
          h('div', { className: 'row' },
            button(status?.connected ? 'Reconnect' : 'Connect ChatGPT', 'login', async () => { await request('/login', {}); await loadStatus(); }, { variant: 'primary', disabled: Boolean(busy) || !status || login?.state === 'pending' }),
            login?.state === 'pending' && button('Cancel sign-in', 'cancel', async () => { await request('/login/cancel', {}); await loadStatus(); }),
            status?.connected && button('Disconnect', 'logout', async () => { await request('/logout', {}); await loadStatus(); }),
            button('Refresh models', 'models', async () => {
              const list = await request('/models/refresh', {});
              setMessage(`${list.length} subscription models refreshed.`);
            }, { disabled: Boolean(busy) || !status?.connected })),
          login?.notice && h('p', { role: 'status' }, login.notice, login.code && ` Code: ${login.code}`),
          loginUrl && h('a', { href: loginUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Continue sign-in ↗'),
          login?.prompt && h('div', { className: 'field' }, h('label', { htmlFor: 'openai-auth-answer' }, login.prompt.message),
            login.prompt.type === 'select' ? h(Choice, { label: login.prompt.message, value: answer, options: login.prompt.options, onChange: setAnswer }) : input('openai-auth-answer', answer, setAnswer, { type: login.prompt.type === 'secret' ? 'password' : 'text', autoComplete: 'off' }),
            button('Continue', 'answer', async () => { await request('/login/answer', { value: answer }); setAnswer(''); await loadStatus(); }))),
        h('section', { className: 'section' },
          h('div', { className: 'row spread' }, h('h3', null, 'Usage remaining'), button('Refresh', 'usage', loadUsage, { disabled: Boolean(busy) || !status?.connected })),
          ...(usage?.buckets?.length ? usage.buckets : [{ id: 'codex', name: 'Codex' }]).map(bucket => h('div', { key: bucket.id },
            h('small', null, bucket.name), h('div', { className: 'limits' },
              h(Limit, { label: '5 hours', window: bucket.fiveHour }), h(Limit, { label: 'Weekly', window: bucket.weekly }),
              ...(bucket.windows ?? []).filter(w => w.minutes !== 300 && w.minutes !== 10080).map((window, i) => h(Limit, { key: i, label: window.minutes == null ? 'Other window' : `${window.minutes} minutes`, window }))))),
          h('small', null, usage ? `${usage.plan ? usage.plan + ' · ' : ''}Updated ${new Date(usage.fetchedAt).toLocaleTimeString()}` : 'Connect to see your allowance and reset times.')),
        status && h(ImagePreferences, { request, apiConnected: status.apiConnected }),
        h('section', { className: 'section' }, h('details', null, h('summary', null, 'Optional API key'),
          h('p', { className: 'muted' }, 'OpenAI API usage is separately billed. API chat models appear under openai in DSH’s model picker.'),
          h(Tag, null, status?.apiConnected ? 'Key saved' : 'Not connected'),
          field('OpenAI API key', 'openai-api-key', input('openai-api-key', apiKey, setApiKey, { type: 'password', autoComplete: 'off', spellCheck: false, placeholder: 'sk-…' })),
          h('div', { className: 'row' }, button('Save key', 'api-key', async () => { try { await request('/api/key', { key: apiKey }); } finally { setApiKey(''); } await loadStatus(); }, { disabled: Boolean(busy) || !apiKey.trim() }),
            status?.apiConnected && button('Remove key', 'api-remove', async () => { await request('/api/disconnect', {}); await loadStatus(); }),
            status?.apiConnected && button('Check API models', 'api-models', async () => { const list = await request('/api/models/refresh', {}); setMessage(`${list.length} API chat models enabled.`); })))),

      );
    }

    function ImagePreferences({ request, apiConnected }) {
      const [source, setSource] = useState(null), [model, setModel] = useState('');
      const [models, setModels] = useState([]), [loading, setLoading] = useState(true);
      const [message, setMessage] = useState(''), [saving, setSaving] = useState(false);
      const [refresh, setRefresh] = useState(0);
      useEffect(() => {
        const controller = new AbortController();
        request('/image/settings', undefined, controller.signal).then(saved => {
          if (!controller.signal.aborted) { setModel(saved.model); setSource(saved.source); }
        }).catch(error => { if (!controller.signal.aborted) setMessage(error.message); });
        return () => controller.abort();
      }, [request]);
      useEffect(() => {
        if (!source) return;
        const controller = new AbortController();
        setLoading(true); setModels([]);
        request('/image/models?source=' + source, undefined, controller.signal).then(data => {
          if (controller.signal.aborted) return;
          setModels(data.models); setModel(previous => data.models.some(m => m.id === previous) ? previous : '');
          setMessage(data.models.length ? '' : 'Connect an API key to load available image models.');
        }).catch(error => { if (!controller.signal.aborted) setMessage(error.message); })
          .finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
      }, [request, source, apiConnected, refresh]);
      return h('section', { className: 'section' }, h('h3', null, 'Image model'),
        h('p', { className: 'muted' }, 'Ask for an image normally in chat. Your chat agent will use this saved connection and model.'),
        h('div', { className: 'row' },
          h(Choice, { label: 'Image connection', value: source, options: [{ id: 'subscription', name: 'ChatGPT subscription' }, { id: 'api', name: 'OpenAI API · paid' }], disabled: saving || !source, onChange: next => { if (next === source) return; setLoading(true); setModels([]); setModel(''); setSource(next); } }),
          h(Choice, { label: 'Image model', value: model, options: models, onChange: setModel, disabled: loading || saving || !models.length }),
          h(Button, { size: 'sm', disabled: saving || !source, onClick: () => setRefresh(n => n + 1) }, 'Refresh models')),
        source === 'api' && h('p', { className: 'muted' }, 'Saving API access enables separately billed image requests from chat. There is no automatic subscription fallback.'),
        h('p', null, h(Button, { variant: 'outline', size: 'sm', disabled: saving || loading || !models.some(m => m.id === model), onClick: async () => {
          setSaving(true); setMessage('');
          try { await request('/image/settings', { source, model }); setMessage('Saved. Image requests in chat will use this selection.'); }
          catch (error) { if (error.name !== 'AbortError') setMessage(error.message); }
          finally { setSaving(false); }
        } }, saving ? 'Saving…' : source === 'api' ? 'Save image model · paid API' : 'Save image model')),
        message && h('p', { role: 'status', className: 'muted' }, message));
    }

    // ponytail: DSH has no menu-child slot; replace only its model seat, using
    // the native shared directory. Switch to a menu extension slot when available.
    function ChatModelPicker({ locked, available, directory, load, select, t }) {
      const state = useSyncExternalStore(fn => directory.subscribe(fn), () => directory.getSnapshot());
      const [open, setOpen] = useState(false), [pane, setPane] = useState('root');
      const [speeds, setSpeeds] = useState({ modes: {}, catalog: {} });
      const [saving, setSaving] = useState(false), [error, setError] = useState('');
      const trigger = useRef(null), pending = useRef(null);
      const current = state.current;
      const choices = state.groups.flatMap(group => group.models.map(model => ({ group, model })));
      const choice = choices.find(c => c.group.id === current?.provider && c.model.id === current?.model);
      const reasoning = choice?.model.reasoning;
      const effort = current?.reasoningEffort ?? reasoning?.defaultEffort;
      const effortLabel = reasoning && (reasoning.efforts.find(e => e.id === effort)?.name ?? effort ?? t('effort.providerDefault'));
      const label = choice?.model.name ?? (current ? `${current.provider}/${current.model}` : t('trigger.fallback'));
      const subscription = current?.provider === 'openai-codex';
      const speedModes = speeds.catalog[current?.model] ?? [{ id: 'default', name: 'Standard' }];
      const speed = speeds.modes[current?.model] ?? 'default';
      const speedLabel = speedModes.find(s => s.id === speed)?.name ?? speed;
      const busy = locked || saving || state.status === 'selecting';
      // Changing panes changes the menu height, so ask the native Menu to place it again.
      const getAnchorRect = useCallback(() => trigger.current?.getBoundingClientRect() ?? null, [pane, speeds, state, error]);
      const request = async (body, signal) => {
        const bootstrap = await fetch('/codex-subscription/bootstrap', { headers: { 'X-Codex-UI': '1' }, signal });
        if (!bootstrap.ok) throw Error('Open DSH on localhost to change speed.');
        const { csrf } = await bootstrap.json();
        const response = await fetch('/codex-subscription/speed/settings', {
          method: body ? 'POST' : 'GET', signal,
          headers: { 'X-Codex-CSRF': csrf, 'Content-Type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const data = await response.json();
        if (!response.ok) throw Error(data.error ?? 'Could not load model speed.');
        return data;
      };
      useEffect(() => {
        if (!open || !subscription) return;
        const controller = new AbortController();
        request(undefined, controller.signal).then(setSpeeds).catch(e => { if (!controller.signal.aborted) setError(e.message); });
        return () => controller.abort();
      }, [open, subscription, current?.model]);
      useEffect(() => { setSaving(false); return () => pending.current?.abort(); }, [current?.provider, current?.model]);
      useEffect(() => { setOpen(false); setPane('root'); setError(''); }, [current?.provider, current?.model]);
      if (!available) return null;
      const close = () => { setOpen(false); setPane('root'); };
      let items, selectedId;
      if (pane === 'root') {
        items = [{ id: 'model', label: `${t('menu.model')} · ${label}` }];
        if (reasoning) items.push({ id: 'effort', label: `${t('menu.effort')} · ${effortLabel}` });
        if (subscription) items.push({ id: 'speed', label: `Speed · ${speedLabel}` });
      } else if (pane === 'model') {
        items = state.groups.flatMap(group => [
          { id: `group:${group.id}`, type: 'label', text: group.name },
          ...group.models.map(model => ({ id: JSON.stringify([group.id, model.id]), label: model.name, disabled: busy })),
        ]);
        selectedId = current && JSON.stringify([current.provider, current.model]);
        if (state.status === 'loading') items.unshift({ id: 'loading', label: t('status.loading'), disabled: true });
        if (state.error || state.failures.length) items.push({ id: 'reload', label: t('retry') });
      } else if (pane === 'effort') {
        items = [
          ...(reasoning?.defaultEffort === undefined ? [{ id: 'provider-default', label: t('effort.providerDefault') }] : []),
          ...(reasoning?.efforts ?? []).map(e => ({ id: e.id, label: e.name })),
        ].map(item => ({ ...item, disabled: busy }));
        selectedId = effort ?? 'provider-default';
      } else {
        items = speedModes.map(mode => ({ id: mode.id, label: mode.name, disabled: busy }));
        selectedId = speed;
      }
      const choose = async id => {
        setError('');
        if (id === 'back') { setPane('root'); return; }
        if (id === 'reload') { load(); return; }
        if (pane === 'root') { setPane(id); return; }
        if (pane === 'speed') {
          const controller = new AbortController(); pending.current = controller; setSaving(true);
          try { setSpeeds(await request({ model: current.model, mode: id }, controller.signal)); close(); }
          catch (e) { if (!controller.signal.aborted) setError(e.message); }
          finally { if (!controller.signal.aborted) setSaving(false); }
          return;
        }
        const selection = pane === 'model' ? (() => {
          const [provider, model] = JSON.parse(id);
          return { provider, model };
        })() : { provider: current.provider, model: current.model, ...(id === 'provider-default' ? {} : { reasoningEffort: id }) };
        try { if (await select(selection)) close(); else setError(directory.getSnapshot().error ?? 'Could not change model.'); }
        catch (e) { setError(e.message); }
      };
      return h(Menu, { key: pane, open, onClose: close, portal: true, side: 'top', autoFocus: true, getAnchorRect,
        items, selectedId, onSelect: choose,
        footer: [
          ...(pane === 'root' ? [] : [{ id: 'back', label: '← Back' }]),
          ...(pane === 'speed' ? [{ id: 'allowance', type: 'label', text: 'Faster modes use more allowance.' }] : []),
          ...(error || state.error ? [{ id: 'error', type: 'label', text: error || state.error }] : []),
        ],
        anchor: h('button', { ref: trigger, type: 'button', disabled: busy,
          'aria-label': `Model: ${label}${effortLabel ? ` · ${effortLabel}` : ''}${subscription ? ` · ${speedLabel}` : ''}`,
          'aria-haspopup': 'menu', 'aria-expanded': open,
          style: { display: 'inline-flex', alignItems: 'center', gap: 6, border: 0, borderRadius: 8, padding: '6px 8px', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', font: 'inherit', fontSize: 12, cursor: 'pointer' },
          onClick: () => { setError(''); setPane('root'); setOpen(!open); if (!open) load(); },
        }, label, effortLabel && ` · ${effortLabel}`, subscription && ` · ${speedLabel}`, h(IconChevronDownOutline14)),
      });
    }

    return {
      inject: ['slots', 'modelDirectories', 'sessions', 'remote', 'remote.session'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'openai-connect', order: 15, label: () => 'OpenAI Connect',
        }, OpenAISettings));
        ctx.slots.inject('conversation.input.model', () => ctx.slots.register({
          name: 'conversation.input.model', priority: -10, locale: 'model',
          inject: sessionId => {
            const directory = ctx.modelDirectories.directoryFor(sessionId);
            const available = ctx.sessions.subagentAddress(sessionId) === undefined;
            return { available, directory: directory.store,
              load: () => { if (available) directory.load().catch(() => {}); },
              select: selection => available ? directory.select(selection).then(() => true, () => false) : Promise.resolve(false),
            };
          },
        }, ChatModelPicker));
      },
    };
  },
});
