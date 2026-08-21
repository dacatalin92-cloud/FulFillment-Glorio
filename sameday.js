// Sameday courier API client + background poller.
// Same integration as the previous Claude-based pipeline: authenticate once,
// re-authenticate lazily on 401, and always send a real browser User-Agent
// because Sameday sits behind Cloudflare and blocks bare requests (403 / error 1010).
const fetch = require('node-fetch');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BASE = 'https://api.sameday.ro';

let token = null;
let tokenExpiresAt = 0;

async function authenticate() {
  const res = await fetch(`${BASE}/api/authenticate`, {
    method: 'POST',
    headers: {
      'X-Auth-Username': process.env.SAMEDAY_USERNAME,
      'X-Auth-Password': process.env.SAMEDAY_PASSWORD,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
      Accept: 'application/json',
    },
    body: 'remember_me=true',
  });
  if (!res.ok) throw new Error(`Sameday auth failed: HTTP ${res.status}`);
  const body = await res.json();
  token = body.token;
  // Token is valid ~2 weeks; refresh a bit early to be safe.
  tokenExpiresAt = Date.now() + 12 * 24 * 3600 * 1000;
  return token;
}

async function ensureToken() {
  if (!token || Date.now() > tokenExpiresAt) await authenticate();
  return token;
}

async function getStatus(awb) {
  const t = await ensureToken();
  let res = await fetch(`${BASE}/api/client/awb/${encodeURIComponent(awb)}/status`, {
    headers: { 'X-Auth-Token': t, 'User-Agent': UA, Accept: 'application/json' },
  });
  if (res.status === 401) {
    // Token expired/invalid server-side — re-auth once and retry.
    await authenticate();
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
  for (const row of rows) {
    try {
      const result = await getStatus(row.awb);
      onUpdate(row.awb, result);
    } catch (err) {
      onUpdate(row.awb, { error: String(err.message || err) });
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return rows.length;
}

function startPoller(db, onUpdate, intervalMs) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const n = await pollOnce(db, onUpdate);
      console.log(`[sameday] polled ${n} AWB(s)`);
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
