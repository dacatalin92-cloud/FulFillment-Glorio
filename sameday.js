// Sameday courier API client + background poller.
// Same integration as the previous Claude-based pipeline: authenticate once,
// re-authenticate lazily on 401, and always send a real browser User-Agent
// because Sameday sits behind Cloudflare and blocks bare requests (403 / error 1010).
// Per Sameday's official API docs (v3.4): the /api/authenticate limit is
// 12 requests/IP/minute — the cooldown below keeps us far under that.
const fetch = require('node-fetch');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BASE = 'https://api.sameday.ro';

let token = null;
let tokenExpiresAt = 0;
// If authentication fails, don't hammer Sameday's login endpoint once per
// AWB in the same poll cycle (that's exactly what turns a single bad
// credential/IP block into a 403/429 storm) — back off for a bit instead.
let lastAuthFailureAt = 0;
const AUTH_FAILURE_COOLDOWN_MS = 60 * 1000;

async function authenticate() {
  try {
    // Confirmed-working format (matches the previous, still-functional
    // Python-based pipeline): remember_me goes in an urlencoded form body,
    // not as a query-string param — despite what the official PDF docs say.
    const formBody = new URLSearchParams({ remember_me: 'true' });
    const res = await fetch(`${BASE}/api/authenticate`, {
      method: 'POST',
      headers: {
        'X-Auth-Username': process.env.SAMEDAY_USERNAME,
        'X-Auth-Password': process.env.SAMEDAY_PASSWORD,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA,
        Accept: 'application/json',
      },
      body: formBody.toString(),
    });
    if (!res.ok) throw new Error(`Sameday auth failed: HTTP ${res.status}`);
    const respBody = await res.json();
    token = respBody.token;
    // With remember_me=true the token is valid ~2 weeks. Trust their
    // expire_at_utc if present (refreshed a bit early); otherwise fall back
    // to a 12-day estimate, refreshed 2 days early.
    tokenExpiresAt = respBody.expire_at_utc
      ? new Date(respBody.expire_at_utc.replace(' ', 'T') + 'Z').getTime() - 6 * 3600 * 1000
      : Date.now() + 12 * 24 * 3600 * 1000;
    lastAuthFailureAt = 0;
    return token;
  } catch (err) {
    token = null;
    tokenExpiresAt = 0;
    lastAuthFailureAt = Date.now();
    throw err;
  }
}

async function ensureToken() {
  if (token && Date.now() <= tokenExpiresAt) return token;
  if (lastAuthFailureAt && Date.now() - lastAuthFailureAt < AUTH_FAILURE_COOLDOWN_MS) {
    throw new Error('Sameday auth on cooldown after a recent failure — will retry automatically');
  }
  await authenticate();
  return token;
}

async function getStatus(awb) {
  const t = await ensureToken();
  let res = await fetch(`${BASE}/api/client/awb/${encodeURIComponent(awb)}/status`, {
    headers: { 'X-Auth-Token': t, 'User-Agent': UA, Accept: 'application/json' },
  });
  if (res.status === 401) {
    // Token expired/invalid server-side — re-auth once (via ensureToken, so
    // a failure here also respects the cooldown) and retry.
    token = null;
    tokenExpiresAt = 0;
    await ensureToken();
    res = await fetch(`${BASE}/api/client/awb/${encodeURIComponent(awb)}/status`, {
      headers: { 'X-Auth-Token': token, 'User-Agent': UA, Accept: 'application/json' },
    });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const es = data.expeditionStatus || {};
  const summary = data.expeditionSummary || {};
  return {
    status: es.status || null,
    statusLabel: es.statusLabel || null,
    state: es.statusState || null,
    cod: typeof summary.cashOnDelivery === 'number' ? summary.cashOnDelivery : null,
  };
}

/**
 * Polls Sameday for every AWB from `today` (plus a short lookback so
 * yesterday's late pickups still get a final status) that hasn't reached a
 * settled state yet. Calls `onUpdate(awb, result)` for each one so the
 * caller can persist + broadcast. Runs one AWB at a time with a small delay
 * — Sameday's API is not built for bursts.
 */
function isSettled(row) {
  const s = (row.sameday_status || '').toLowerCase();
  return s.includes('livrat') || s.includes('anulat') || s.includes('retur');
}

async function pollOnce(db, onUpdate) {
  const days = db.listDays().slice(0, 2); // today + yesterday is plenty for pickup lag
  const rows = days.flatMap((d) => db.listForDay(d)).filter((r) => !isSettled(r));
  let ok = 0;
  let failed = 0;
  let lastError = null;
  for (const row of rows) {
    try {
      const result = await getStatus(row.awb);
      onUpdate(row.awb, result);
      ok++;
    } catch (err) {
      lastError = String(err.message || err);
      onUpdate(row.awb, { error: lastError });
      failed++;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { total: rows.length, ok, failed, lastError };
}

function startPoller(db, onUpdate, intervalMs) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { total, ok, failed, lastError } = await pollOnce(db, onUpdate);
      console.log(`[sameday] polled ${total} AWB(s) — ${ok} ok, ${failed} failed${lastError ? ` (last error: ${lastError})` : ''}`);
    } catch (err) {
      console.error('[sameday] poll error', err);
    } finally {
      running = false;
    }
  };
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { authenticate, getStatus, startPoller, pollOnce };
