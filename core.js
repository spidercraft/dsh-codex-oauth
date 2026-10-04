export const PROVIDER = 'openai-codex';
export const BASE = 'https://chatgpt.com/backend-api';

export function remainingWindow(window) {
  if (!window) return null;
  const used = window.used_percent ?? window.usedPercent;
  const minutes = window.windowDurationMins ?? (window.limit_window_seconds == null ? null : window.limit_window_seconds / 60);
  const reset = window.reset_at ?? window.resetsAt;
  return {
    remainingPercent: typeof used === 'number' && Number.isFinite(used) ? Math.max(0, Math.min(100, 100 - used)) : null,
    minutes: typeof minutes === 'number' && Number.isFinite(minutes) ? minutes : null,
    resetsAt: typeof reset === 'number' && Number.isFinite(reset) ? reset : null,
  };
}

export function usageSummary(raw) {
  const buckets = [];
  const add = (id, name, limit) => {
    if (!limit) return;
    const windows = [remainingWindow(limit.primary_window ?? limit.primary), remainingWindow(limit.secondary_window ?? limit.secondary)].filter(Boolean);
    buckets.push({ id, name, windows,
      fiveHour: windows.find(w => w.minutes === 300) ?? null,
      weekly: windows.find(w => w.minutes === 10080) ?? null,
    });
  };
  if (raw.rateLimitsByLimitId && Object.keys(raw.rateLimitsByLimitId).length) {
    for (const [id, limit] of Object.entries(raw.rateLimitsByLimitId)) add(id, limit.limitName ?? id, limit);
  } else {
    add('codex', 'Codex', raw.rate_limit ?? raw.rateLimits);
    for (const limit of raw.additional_rate_limits ?? []) add(limit.metered_feature ?? limit.limit_name, limit.limit_name ?? limit.metered_feature, limit.rate_limit);
  }
  return { plan: raw.plan_type ?? null, fetchedAt: new Date().toISOString(), buckets };
}

export function accountId(token) {
  // Only a routing hint from an already-held token; never used to authorize local access.
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url'))['https://api.openai.com/auth']?.chatgpt_account_id; }
  catch { return undefined; }
}

export function modelEntries(raw, includeSpeed = false) {
  const rows = raw.models ?? raw.data;
  if (!Array.isArray(rows)) throw new Error('OpenAI returned an unrecognized model list.');
  const seen = new Set();
  return rows.flatMap(m => {
    const id = m.slug ?? m.id;
    if (typeof id !== 'string' || !id || seen.has(id)) return [];
    seen.add(id);
    const entry = { id, name: m.display_name ?? m.name ?? id };
    if (includeSpeed) {
      const tiers = Array.isArray(m.service_tiers) && m.service_tiers.length ? m.service_tiers
        : (Array.isArray(m.additional_speed_tiers) ? m.additional_speed_tiers : []).map(id => ({ id }));
      const unique = new Map([['default', { id: 'default', name: 'Standard' }]]);
      for (const tier of tiers) {
        if (typeof tier?.id === 'string' && /^[a-z][a-z0-9_-]{0,40}$/.test(tier.id) && tier.id !== 'default') {
          unique.set(tier.id, { id: tier.id, name: tier.name ?? (tier.id === 'ultrafast' ? 'Ultra' : tier.id.charAt(0).toUpperCase() + tier.id.slice(1)) });
        }
      }
      entry.speedModes = [...unique.values()];
    }
    if (Number.isFinite(m.context_window) && m.context_window > 0) entry.contextWindow = m.context_window;
    if (Number.isFinite(m.max_output_tokens) && m.max_output_tokens > 0) entry.maxTokens = m.max_output_tokens;
    if (Array.isArray(m.input_modalities)) entry.input = m.input_modalities.filter(x => x === 'text' || x === 'image');
    // DSH/pi-ai currently exposes this fixed set of effort choices.
    const supported = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    if (Array.isArray(m.supported_reasoning_levels)) {
      entry.reasoningEfforts = Object.fromEntries(m.supported_reasoning_levels.flatMap(r => {
        const effort = typeof r === 'string' ? r : r.effort;
        return supported.has(effort) ? [[effort, effort]] : [];
      }));
      if (!Object.keys(entry.reasoningEfforts).length) delete entry.reasoningEfforts;
    }
    return [entry];
  });
}

export async function checked(response) {
  if (response.ok) return response;
  // Never include upstream response bodies, which can contain credentials or user data.
  const hints = { 401: 'Sign in again.', 403: 'This account does not have access to this feature.', 429: 'Usage limit reached; check the reset time.' };
  throw new Error(`OpenAI request failed (HTTP ${response.status}). ${hints[response.status] ?? 'The selected model or feature may not be available through your subscription.'}`);
}

export function localRequest(req) {
  const local = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  if (!local.has(req.socket.remoteAddress)) return false;
  let host;
  try { host = new URL(`http://${req.headers.host}`); } catch { return false; }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname)) return false;
  if (req.headers.origin && req.headers.origin !== host.origin) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  return true;
}
