require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fetch = require('node-fetch');
const { WebSocketServer } = require('ws');

const db = require('./db');
const sameday = require('./sameday');
const shopify = require('./shopify');

const PORT = process.env.PORT || 3000;
const PACK_WINDOW_MS = 30000;
// 5 seconds caused the server to crash-loop in production (a native SQLite
// assertion, from creating/destroying prepared statements at very high
// frequency — fixed separately in db.js by caching statements, but running
// the poll near-continuously is still much heavier load than needed). 30
// seconds is a safe middle ground: still 4x faster than the original 2
// minutes, without hammering Sameday's API or the DB nonstop.
const SAMEDAY_POLL_MS = 30 * 1000;
const BACKFILL_INTERVAL_MS = 15 * 60 * 1000; // safety net in case a webhook is ever missed

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(payload);
  });
}

// "packed" is primarily a warehouse-floor fact confirmed by a scan at the
// station — but not every order goes through this app's station. Some are
// fulfilled through the older/other process, and for those Sameday's own
// tracking is the only signal that they ever left the warehouse ("cele care
// au ajuns sa aibe scan de la ei, au fost sigur impachetate"). So Sameday
// status DOES get to mark something packed — just never instantly. Only two
// real "still sitting with us" statuses exist; anything past that means a
// courier scan happened.
const PENDING_PICKUP_PHRASES = ['alocata pentru ridicare', 'ridicare ulterioara'];
function samedayIndicatesPickedUp(status) {
  const t = (status || '').toLowerCase();
  if (!t) return false;
  if (t.includes('anulat')) return false;
  return !PENDING_PICKUP_PHRASES.some((p) => t.includes(p));
}

// The original incident: this same "picked up" check ran INSTANTLY, right
// when the AWB was printed, and Sameday's status text for a brand-new label
// didn't match the two known "still pending" phrases — so it read as
// "already picked up" within seconds of printing. A courier physically
// cannot pick something up seconds after the label exists, so nothing gets
// auto-packed from Sameday status until it's had time to become real. This
// is also what makes the live poller (every 30s, see startPoller below) a
// standing reconciliation pass — old-process orders self-heal to packed as
// soon as they age past this window and Sameday shows real movement.
const MIN_AWB_AGE_FOR_AUTO_PACK_MS = 30 * 60 * 1000; // 30 minutes

function applySamedayUpdate(awb, result) {
  let row = db.updateSameday(awb, result);
  if (row && !row.packed && !row.cancelled && samedayIndicatesPickedUp(row.sameday_status)) {
    const ageMs = Date.now() - new Date(row.awb_created_at).getTime();
    if (ageMs >= MIN_AWB_AGE_FOR_AUTO_PACK_MS) {
      row = db.markPackedFromReconciliation(awb, row.sameday_checked_at || new Date().toISOString());
      console.log(`[sameday] ${awb} reconciled as packed (courier status: ${row.sameday_status})`);
    }
  }
  broadcast({ type: 'awb:update', awb: row });
  return row;
}

// On-demand version of the same reconciliation the live poller does
// gradually — sweeps every currently-unpacked AWB against its last-known
// Sameday status right now, for catching up a backlog immediately (e.g.
// right after the false-packed cleanup) instead of waiting on the 30s
// poller to cycle through all of them. Uses the cached sameday_status
// already in the DB rather than hitting Sameday's API again — that column
// is kept fresh by the poller regardless.
function reconcileWithSameday(minAgeMinutes) {
  const minAgeMs = minAgeMinutes * 60 * 1000;
  const now = Date.now();
  return db.listUnpackedNotCancelled().filter((row) => {
    if (!samedayIndicatesPickedUp(row.sameday_status)) return false;
    return now - new Date(row.awb_created_at).getTime() >= minAgeMs;
  });
}

// --- Shopify webhook: fulfillments/create -----------------------------
// Needs the raw body for HMAC verification, so this route uses its own
// raw-body parser instead of the app-wide express.json().
app.post(
  '/webhooks/fulfillments-create',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const hmac = req.get('X-Shopify-Hmac-Sha256');
      const ok = shopify.verifyWebhookHmac(req.body, hmac, process.env.SHOPIFY_CLIENT_SECRET);
      if (!ok) return res.status(401).send('invalid signature');
      res.status(200).send('ok'); // ack immediately, Shopify retries on timeout/non-2xx

      const payload = JSON.parse(req.body.toString('utf8'));
      await handleFulfillmentPayload(payload);
    } catch (err) {
      console.error('[webhook] processing error', err);
      if (!res.headersSent) res.status(500).send('error');
    }
  }
);

async function handleFulfillmentPayload(payload) {
  if ((payload.status || '').toLowerCase() !== 'success') return;
  const company = (payload.tracking_company || '').toLowerCase();
  if (!company.includes('sameday')) return;
  const awb = payload.tracking_number;
  if (!awb) return;

  const orderGid = `gid://shopify/Order/${payload.order_id}`;
  const order = await shopify.fetchOrderDetails(orderGid);
  if (!order) return;

  const row = db.upsertAwb({
    awb,
    order_name: order.name,
    order_created_at: order.createdAt,
    awb_created_at: payload.created_at,
    total: order.total,
    currency: order.currency,
    items: order.items,
    order_id: payload.order_id,
  });
  broadcast({ type: 'awb:new', awb: row });
  console.log(`[webhook] new AWB ${awb} for ${order.name}`);

  // Get a first real status right away instead of waiting for the next poll tick
  // — unless Sameday polling is paused (SAMEDAY_POLL_ENABLED=false), in which
  // case skip this too rather than sneaking in auth attempts another way.
  if (process.env.SAMEDAY_POLL_ENABLED !== 'false') {
    try {
      const status = await sameday.getStatus(awb);
      applySamedayUpdate(awb, status);
    } catch (err) {
      console.error(`[webhook] sameday status fetch failed for ${awb}`, err);
    }
  }
}

// --- Shopify webhook: orders/cancelled -----------------------------------
// Sameday does NOT auto-cancel the AWB when the Shopify order is cancelled,
// so this is our own signal to pull a cancelled order out of the packing
// flow. A cancelled order can (rarely) have more than one AWB — markOrderCancelled
// handles all of them and we broadcast an update for each.
app.post(
  '/webhooks/orders-cancelled',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const hmac = req.get('X-Shopify-Hmac-Sha256');
      const ok = shopify.verifyWebhookHmac(req.body, hmac, process.env.SHOPIFY_CLIENT_SECRET);
      if (!ok) return res.status(401).send('invalid signature');
      res.status(200).send('ok');

      const payload = JSON.parse(req.body.toString('utf8'));
      const orderId = String(payload.id);
      const updatedRows = db.markOrderCancelled(orderId);
      updatedRows.forEach((row) => broadcast({ type: 'awb:update', awb: row }));
      if (updatedRows.length) {
        console.log(`[webhook] order ${orderId} cancelled — ${updatedRows.length} AWB(s) taken out of the packing flow`);
      }
    } catch (err) {
      console.error('[webhook] orders-cancelled processing error', err);
      if (!res.headersSent) res.status(500).send('error');
    }
  }
);

// --- One-time setup: register Shopify webhooks ---------------------------
// Registers this server's own webhook URLs with Shopify, authenticated as
// THIS app (via the same client_credentials exchange used for the Admin
// API), so webhooks end up signed with SHOPIFY_CLIENT_SECRET — the secret
// this server actually verifies against. Guarded by that same secret as a
// query param so it can be triggered once from a browser. Safe to call again
// later (e.g. after adding a new webhook here) — Shopify just reports a
// userError for any topic/URI combo that's already registered.
const WEBHOOKS_TO_REGISTER = [
  { topic: 'FULFILLMENTS_CREATE', path: '/webhooks/fulfillments-create' },
  { topic: 'ORDERS_CANCELLED', path: '/webhooks/orders-cancelled' },
];
app.get('/admin/setup-webhook', async (req, res) => {
  if (!process.env.SHOPIFY_CLIENT_SECRET || req.query.secret !== process.env.SHOPIFY_CLIENT_SECRET) {
    return res.status(403).send('forbidden');
  }
  try {
    const results = [];
    for (const w of WEBHOOKS_TO_REGISTER) {
      const uri = `https://${req.get('host')}${w.path}`;
      const data = await shopify.shopifyGraphql(
        `mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
          webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
            webhookSubscription { id topic uri }
            userErrors { field message }
          }
        }`,
        { topic: w.topic, sub: { uri, format: 'JSON' } }
      );
      results.push({ topic: w.topic, ...data.webhookSubscriptionCreate });
    }
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Diagnostic: reports the public IP this server's outbound requests use —
// useful to hand Sameday support an exact address to check/whitelist.
app.get('/admin/whoami', async (req, res) => {
  try {
    const r = await fetch('https://api.ipify.org?format=json');
    const body = await r.json();
    res.json({ outboundIp: body.ip });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// TEMPORARY diagnostic: shows a masked preview + length of the secret this
// server actually has configured, so it can be visually compared against
// what's pasted into a URL — without ever printing the full value. Remove
// this route once the /admin/backfill-old 403 mismatch is resolved.
function maskedPreview(s) {
  return s.length > 8 ? `${s.slice(0, 4)}...${s.slice(-4)}` : '(too short to preview safely)';
}

app.get('/admin/secret-debug', (req, res) => {
  const s = process.env.SHOPIFY_CLIENT_SECRET || '';
  if (!s) return res.json({ configured: false });
  const result = {
    configured: true,
    length: s.length,
    preview: maskedPreview(s),
  };
  // Pass ?got=<value you're about to use in the URL> to compare it directly
  // against the real configured secret, without ever showing either in full.
  if (typeof req.query.got === 'string') {
    const g = req.query.got;
    result.got = { length: g.length, preview: maskedPreview(g), match: g === s };
  }
  res.json(result);
});

// One-time (or occasional) manual pull of older AWBs — the automatic
// backfillToday() only ever looks at today. This brings AWBs from the last
// N days into the new system, e.g. so anything still unpacked from before
// the webhook went live shows up here too. Guarded the same way as the
// other /admin routes. Usage: /admin/backfill-old?secret=...&days=7
app.get('/admin/backfill-old', async (req, res) => {
  if (!process.env.SHOPIFY_CLIENT_SECRET || req.query.secret !== process.env.SHOPIFY_CLIENT_SECRET) {
    return res.status(403).send('forbidden');
  }
  const days = Math.max(1, Math.min(60, parseInt(req.query.days, 10) || 7));
  const debug = req.query.debug === '1';
  try {
    const result = await backfillRange(days, debug);
    const added = debug ? result.added : result;
    if (added) broadcast({ type: 'refresh' });
    res.json(debug ? { ...result, days } : { added, days });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// One-off cleanup for the now-removed auto-pack-from-courier bug: some AWBs
// got marked packed within moments of their label being printed, without
// anyone actually scanning them (see db.js findFalsePackedCandidates for the
// exact detection rule). Dry-run by default — lists what would be reset;
// pass &apply=1 to actually reset them back to unpacked so they return to
// the normal picking list. Usage: /admin/fix-false-packed?secret=...
// (add &apply=1 once the dry-run list looks right; &maxAgeMin=N to widen/
// narrow the "packed within N minutes of creation" window, default 15).
app.get('/admin/fix-false-packed', (req, res) => {
  if (!process.env.SHOPIFY_CLIENT_SECRET || req.query.secret !== process.env.SHOPIFY_CLIENT_SECRET) {
    return res.status(403).send('forbidden');
  }
  const maxAgeMin = Math.max(1, Math.min(180, parseInt(req.query.maxAgeMin, 10) || 15));
  const apply = req.query.apply === '1';
  try {
    const candidates = db.findFalsePackedCandidates(maxAgeMin);
    if (!apply) {
      return res.json({
        dryRun: true,
        maxAgeMin,
        count: candidates.length,
        awbs: candidates.map((r) => ({ awb: r.awb, order_name: r.order_name, awb_created_at: r.awb_created_at, packed_at: r.packed_at })),
        hint: 'Looks right? Re-run the same URL with &apply=1 to reset these to unpacked.',
      });
    }
    const updated = db.resetFalsePacked(candidates.map((r) => r.awb));
    updated.forEach((row) => broadcast({ type: 'awb:update', awb: row }));
    res.json({ applied: true, maxAgeMin, count: updated.length, awbs: updated.map((r) => r.awb) });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Reconciliation: some orders are fulfilled through the older/other process
// and never get a manual scan at this app's station — for those, Sameday's
// own tracking is the only proof they actually shipped. The live poller
// already does this gradually every 30s (see applySamedayUpdate above); this
// sweeps everything currently unpacked right now, for an immediate catch-up
// instead of waiting on the poll cycle. Same dry-run-first pattern as
// /admin/fix-false-packed. Usage: /admin/reconcile-sameday?secret=...
// (add &apply=1 once the list looks right; &minAgeMin=N to change the "must
// be at least this old" safety window, default 30 — matches
// MIN_AWB_AGE_FOR_AUTO_PACK_MS).
app.get('/admin/reconcile-sameday', (req, res) => {
  if (!process.env.SHOPIFY_CLIENT_SECRET || req.query.secret !== process.env.SHOPIFY_CLIENT_SECRET) {
    return res.status(403).send('forbidden');
  }
  const minAgeMin = Math.max(1, Math.min(1440, parseInt(req.query.minAgeMin, 10) || 30));
  const apply = req.query.apply === '1';
  try {
    const candidates = reconcileWithSameday(minAgeMin);
    if (!apply) {
      return res.json({
        dryRun: true,
        minAgeMin,
        count: candidates.length,
        awbs: candidates.map((r) => ({ awb: r.awb, order_name: r.order_name, awb_created_at: r.awb_created_at, sameday_status: r.sameday_status })),
        hint: 'Looks right? Re-run the same URL with &apply=1 to mark these packed.',
      });
    }
    const whenIso = new Date().toISOString();
    const updated = candidates.map((r) => db.markPackedFromReconciliation(r.awb, r.sameday_checked_at || whenIso));
    updated.forEach((row) => broadcast({ type: 'awb:update', awb: row }));
    res.json({ applied: true, minAgeMin, count: updated.length, awbs: updated.map((r) => r.awb) });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// The live poller (see startPoller below) only checks Sameday status for
// AWBs created today/yesterday — on purpose, so it doesn't hammer Sameday's
// API with thousands of requests every 30s for orders that settled long ago.
// The tradeoff: for AWBs older than that, sameday_status in the DB can be
// stale or (for very old backlog) never fetched at all, so the cache-based
// /admin/reconcile-sameday above has nothing to work with for them. This
// does the same reconciliation but fetches a FRESH live status per AWB first
// — same 200ms throttle as the poller — then feeds it through the same
// applySamedayUpdate() used everywhere else, so the normal 30-min-age +
// status rules still apply. Meant for the historical backlog, not routine
// use. Runs in the background (the HTTP response returns immediately) since
// a few thousand AWBs at ~200ms each can take several minutes — watch the
// Deploy Logs for "[backfill-status]" progress lines. Usage:
// /admin/backfill-sameday-status?secret=...&limit=3000
let backfillStatusRunning = false;
async function backfillSamedayStatusLive(rows) {
  let ok = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const status = await sameday.getStatus(row.awb);
      applySamedayUpdate(row.awb, status);
      ok++;
    } catch (err) {
      failed++;
      console.error(`[backfill-status] ${row.awb} failed`, err.message || err);
    }
    if ((ok + failed) % 100 === 0) {
      console.log(`[backfill-status] progress ${ok + failed}/${rows.length} (${ok} ok, ${failed} failed)`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`[backfill-status] done — ${ok} ok, ${failed} failed out of ${rows.length}`);
}

app.get('/admin/backfill-sameday-status', (req, res) => {
  if (!process.env.SHOPIFY_CLIENT_SECRET || req.query.secret !== process.env.SHOPIFY_CLIENT_SECRET) {
    return res.status(403).send('forbidden');
  }
  if (backfillStatusRunning) {
    return res.status(409).json({ error: 'a backfill is already running — check Deploy Logs for [backfill-status] progress' });
  }
  const limit = Math.max(1, Math.min(5000, parseInt(req.query.limit, 10) || 3000));
  const rows = db.listUnpackedNotCancelled().slice(0, limit);
  backfillStatusRunning = true;
  backfillSamedayStatusLive(rows).finally(() => {
    backfillStatusRunning = false;
  });
  res.json({
    started: true,
    total: rows.length,
    etaMinutes: Math.ceil((rows.length * 0.2) / 60),
    hint: 'Running in background — watch Deploy Logs for [backfill-status] lines, or just refresh the dashboard in a few minutes.',
  });
});

// Backfill order_id on old AWB rows that predate order_id tracking. The
// normal Shopify crawl (backfillToday/backfillRange) only sets order_id on
// AWBs it's inserting for the FIRST time — it skips (`if (existing) continue`)
// any AWB already present in the DB, so old rows stay with order_id = NULL
// forever. That in turn makes /admin/reconcile-with-shopify skip them (no ID
// to query Shopify with). This looks each one up by order_name instead
// (which every row does have) and fills in order_id directly. Dry-run first,
// same pattern as the other /admin/* routes. Usage:
// /admin/backfill-order-ids?secret=...  (add &apply=1 once it looks right)
async function backfillOrderIds(rows) {
  const results = [];
  for (const row of rows) {
    try {
      const orderId = await shopify.findOrderIdByName(row.order_name);
      results.push({ awb: row.awb, order_name: row.order_name, orderId, action: orderId ? 'set' : 'not-found' });
    } catch (err) {
      results.push({ awb: row.awb, order_name: row.order_name, action: 'error', error: String(err.message || err) });
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return results;
}

let backfillOrderIdsRunning = false;
app.get('/admin/backfill-order-ids', (req, res) => {
  if (!process.env.SHOPIFY_CLIENT_SECRET || req.query.secret !== process.env.SHOPIFY_CLIENT_SECRET) {
    return res.status(403).send('forbidden');
  }
  if (backfillOrderIdsRunning) {
    return res.status(409).json({ error: 'already running — check Deploy Logs for [backfill-order-ids] progress' });
  }
  const apply = req.query.apply === '1';
  const limit = Math.max(1, Math.min(3000, parseInt(req.query.limit, 10) || 3000));
  const rows = db.listUnpackedNotCancelled().filter((r) => !r.order_id).slice(0, limit);
  backfillOrderIdsRunning = true;
  (async () => {
    try {
      const results = await backfillOrderIds(rows);
      const toSet = results.filter((r) => r.action === 'set');
      const notFound = results.filter((r) => r.action === 'not-found');
      const errors = results.filter((r) => r.action === 'error');
      console.log(`[backfill-order-ids] scanned ${results.length} — ${toSet.length} found, ${notFound.length} not found, ${errors.length} errors`);
      if (apply) {
        toSet.forEach((r) => db.setOrderId(r.awb, r.orderId));
        console.log(`[backfill-order-ids] applied — set order_id on ${toSet.length} AWB(s)`);
      }
      global.__lastBackfillOrderIdsResult = { apply, count: results.length, toSet, notFound, errors, finishedAt: new Date().toISOString() };
    } catch (err) {
      console.error('[backfill-order-ids] failed', err);
      global.__lastBackfillOrderIdsResult = { apply, error: String(err.message || err), finishedAt: new Date().toISOString() };
    } finally {
      backfillOrderIdsRunning = false;
    }
  })();
  res.json({
    started: true,
    apply,
    total: rows.length,
    etaMinutes: Math.ceil((rows.length * 0.25) / 60),
    hint: 'Running in background — poll /admin/backfill-order-ids-result?secret=... for the outcome, or watch Deploy Logs for [backfill-order-ids].',
  });
});

app.get('/admin/backfill-order-ids-result', (req, res) => {
  if (!process.env.SHOPIFY_CLIENT_SECRET || req.query.secret !== process.env.SHOPIFY_CLIENT_SECRET) {
    return res.status(403).send('forbidden');
  }
  res.json(global.__lastBackfillOrderIdsResult || { hint: 'no run recorded yet in this process' });
});

// Reconciliation against SHOPIFY itself (not Sameday) — for the specific
// case of old backlog AWBs where Sameday's own status lookup comes back
// empty/erroring (so /admin/reconcile-sameday and the status backfill have
// nothing to work with), but Shopify's order record already tells the truth:
// either the order was cancelled (and our own `cancelled` flag never got set
// because it predates the orders/cancelled webhook), or the order shows
// FULFILLED — meaning a courier scan already happened somewhere, just not
// through this app's own Sameday-status pipeline (e.g. shipped manually by
// an operator under a different/legacy process). Same dry-run-first pattern
// as the other /admin/reconcile-* routes. Usage:
// /admin/reconcile-with-shopify?secret=...  (add &apply=1 once it looks right)
async function reconcileWithShopify(rows) {
  const results = [];
  for (const row of rows) {
    if (!row.order_id) {
      results.push({ awb: row.awb, order_name: row.order_name, action: 'skip', reason: 'no order_id on this row' });
      continue;
    }
    try {
      const data = await shopify.shopifyGraphql(
        `query($id: ID!) { order(id: $id) { cancelledAt displayFulfillmentStatus } }`,
        { id: `gid://shopify/Order/${row.order_id}` }
      );
      const o = data.order;
      if (!o) {
        results.push({ awb: row.awb, order_name: row.order_name, action: 'skip', reason: 'order not found in Shopify' });
      } else if (o.cancelledAt) {
        results.push({ awb: row.awb, order_name: row.order_name, order_id: row.order_id, action: 'cancel', cancelledAt: o.cancelledAt });
      } else if (o.displayFulfillmentStatus === 'FULFILLED') {
        results.push({ awb: row.awb, order_name: row.order_name, action: 'pack', displayFulfillmentStatus: o.displayFulfillmentStatus });
      } else {
        results.push({ awb: row.awb, order_name: row.order_name, action: 'none', displayFulfillmentStatus: o.displayFulfillmentStatus });
      }
    } catch (err) {
      results.push({ awb: row.awb, order_name: row.order_name, action: 'error', error: String(err.message || err) });
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return results;
}

let reconcileShopifyRunning = false;
app.get('/admin/reconcile-with-shopify', (req, res) => {
  if (!process.env.SHOPIFY_CLIENT_SECRET || req.query.secret !== process.env.SHOPIFY_CLIENT_SECRET) {
    return res.status(403).send('forbidden');
  }
  if (reconcileShopifyRunning) {
    return res.status(409).json({ error: 'already running — check Deploy Logs for [reconcile-shopify] progress' });
  }
  const apply = req.query.apply === '1';
  const limit = Math.max(1, Math.min(3000, parseInt(req.query.limit, 10) || 3000));
  const rows = db.listUnpackedNotCancelled().slice(0, limit);
  reconcileShopifyRunning = true;
  (async () => {
    try {
      const results = await reconcileWithShopify(rows);
      const toCancel = results.filter((r) => r.action === 'cancel');
      const toPack = results.filter((r) => r.action === 'pack');
      const errors = results.filter((r) => r.action === 'error');
      console.log(`[reconcile-shopify] scanned ${results.length} — ${toCancel.length} to cancel, ${toPack.length} to pack, ${errors.length} errors`);
      if (apply) {
        const cancelledOrderIds = new Set();
        for (const r of toCancel) {
          if (cancelledOrderIds.has(r.order_id)) continue;
          cancelledOrderIds.add(r.order_id);
          db.markOrderCancelled(r.order_id).forEach((row) => broadcast({ type: 'awb:update', awb: row }));
        }
        for (const r of toPack) {
          const row = db.markPackedFromReconciliation(r.awb, new Date().toISOString());
          if (row) broadcast({ type: 'awb:update', awb: row });
        }
        console.log(`[reconcile-shopify] applied — cancelled ${cancelledOrderIds.size} order(s), packed ${toPack.length} AWB(s)`);
      }
      global.__lastReconcileShopifyResult = { apply, count: results.length, toCancel, toPack, errors, finishedAt: new Date().toISOString() };
    } catch (err) {
      console.error('[reconcile-shopify] failed', err);
      global.__lastReconcileShopifyResult = { apply, error: String(err.message || err), finishedAt: new Date().toISOString() };
    } finally {
      reconcileShopifyRunning = false;
    }
  })();
  res.json({
    started: true,
    apply,
    total: rows.length,
    etaMinutes: Math.ceil((rows.length * 0.25) / 60),
    hint: 'Running in background — poll /admin/reconcile-with-shopify-result?secret=... for the outcome, or watch Deploy Logs for [reconcile-shopify].',
  });
});

app.get('/admin/reconcile-with-shopify-result', (req, res) => {
  if (!process.env.SHOPIFY_CLIENT_SECRET || req.query.secret !== process.env.SHOPIFY_CLIENT_SECRET) {
    return res.status(403).send('forbidden');
  }
  res.json(global.__lastReconcileShopifyResult || { hint: 'no run recorded yet in this process' });
});

// --- REST API -----------------------------------------------------------
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/days', (req, res) => {
  res.json({ days: db.listDays() });
});

app.get('/api/today', (req, res) => {
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Bucharest' });
  res.json({ day, rows: db.listForDay(day) });
});

app.get('/api/day/:day', (req, res) => {
  res.json({ day: req.params.day, rows: db.listForDay(req.params.day) });
});

// --- Dashboard "packed/shipped" view (grouped by pack date, not AWB
// creation date — see db.js listPackedDays/listPackedForDay) -------------
app.get('/api/packed-days', (req, res) => {
  res.json({ days: db.listPackedDays() });
});

app.get('/api/packed-day/:day', (req, res) => {
  res.json({ day: req.params.day, rows: db.listPackedForDay(req.params.day) });
});

app.get('/api/unpacked-count', (req, res) => {
  res.json({ count: db.countUnpacked() });
});

// Full list of every AWB that exists (has a printed label) but is neither
// packed nor cancelled — across ALL days, not just today. This is the real
// "still owed to a courier" backlog: unlike /api/today (which is scoped to
// today's creation date, for the scan-station picking list), this covers
// everything regardless of when the AWB was created.
app.get('/api/unpacked', (req, res) => {
  const rows = db.listUnpackedNotCancelled().sort((a, b) => new Date(a.awb_created_at) - new Date(b.awb_created_at));
  res.json({ count: rows.length, rows });
});

app.get('/api/lookup/:code', (req, res) => {
  const row = db.findByCode(req.params.code);
  if (!row) return res.status(404).json({ found: false });
  res.json({ found: true, row });
});

app.post('/api/scan', (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'missing code' });
  const row = db.findByCode(code);
  if (!row) return res.status(404).json({ found: false });
  const result = db.recordScan(row.awb, new Date().toISOString(), PACK_WINDOW_MS);
  if (result.kind && result.kind !== 'already') {
    broadcast({ type: 'awb:update', awb: result.row });
  }
  res.json({ found: true, kind: result.kind, row: result.row });
});

app.post('/api/note', (req, res) => {
  const { awb, note } = req.body || {};
  if (!awb) return res.status(400).json({ error: 'missing awb' });
  const row = db.setNote(awb, note || '');
  broadcast({ type: 'awb:update', awb: row });
  res.json({ row });
});

// --- Returns --------------------------------------------------------------
// AWBs Sameday currently shows as "in return" (courier bringing it back)
// that nobody has confirmed as physically received yet — not scoped to
// today, since a return can land days after the original order.
app.get('/api/returns', (req, res) => {
  res.json({ rows: db.listPendingReturns() });
});

// History: returns already confirmed as physically received (most recent
// first, capped at 200) — separate from /api/returns above, which only
// lists the ones still waiting for confirmation.
app.get('/api/returns/history', (req, res) => {
  res.json({ rows: db.listReturnHistory() });
});

// Manual confirmation scan: the box physically arrived back at the
// warehouse. Deliberately separate from /api/scan's pack-confirmation flow
// — scanning a returned AWB here never touches `packed`, only `return_received`.
// If the code matches no known AWB at all (a return from another channel,
// an older order, a typo, a damaged label), it's logged as an "unknown
// return" instead of a plain 404 — those need a human to go find out what
// they actually are, not silently vanish as a failed scan.
app.post('/api/scan-return', (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'missing code' });
  const row = db.findByCode(code);
  if (!row) {
    const entry = db.logUnknownReturn(code, new Date().toISOString());
    broadcast({ type: 'unknown-return:new', entry });
    return res.json({ found: false, logged: true, entry });
  }
  const updated = db.markReturnReceived(row.awb, new Date().toISOString());
  broadcast({ type: 'awb:update', awb: updated });
  res.json({ found: true, row: updated });
});

// Unknown-return entries: listing, adding a note, and marking one resolved
// once someone has figured out / handled what it actually was.
app.get('/api/unknown-returns', (req, res) => {
  res.json({ rows: db.listUnknownReturns() });
});

app.post('/api/unknown-returns/:id/note', (req, res) => {
  const { note } = req.body || {};
  const entry = db.setUnknownReturnNote(Number(req.params.id), note || '');
  broadcast({ type: 'unknown-return:update', entry });
  res.json({ entry });
});

app.post('/api/unknown-returns/:id/resolve', (req, res) => {
  const entry = db.resolveUnknownReturn(Number(req.params.id), new Date().toISOString());
  broadcast({ type: 'unknown-return:resolved', entry });
  res.json({ entry });
});

// History: unknown-return entries already resolved (most recent first,
// capped at 200).
app.get('/api/unknown-returns/history', (req, res) => {
  res.json({ rows: db.listResolvedUnknownReturns() });
});

// --- Sameday polling (courier status for open AWBs) ----------------------
// Kill switch: set SAMEDAY_POLL_ENABLED=false in Railway to pause this
// entirely (e.g. while investigating a block/lockout on the Sameday side)
// without touching anything else — AWB tracking via the Shopify webhook
// keeps working either way, this only feeds the courier-status column.
if (process.env.SAMEDAY_POLL_ENABLED === 'false') {
  console.warn('[sameday] polling disabled via SAMEDAY_POLL_ENABLED=false');
} else {
  sameday.startPoller(
    db,
    (awb, result) => applySamedayUpdate(awb, result),
    SAMEDAY_POLL_MS
  );
}

// --- Shopify backfill safety net -----------------------------------------
// Webhooks are the primary path (seconds of latency); this just guards
// against a missed delivery (server restart, transient network blip).
async function backfillToday() {
  const todayKey = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Bucharest' });
  const startIso = new Date(`${todayKey}T00:00:00+03:00`).toISOString(); // Bucharest is UTC+2/+3; adjust below if needed
  let cursor = null;
  let added = 0;
  for (let page = 0; page < 20; page++) {
    const data = await shopify.shopifyGraphql(
      `query($cursor: String) {
        orders(first: 50, after: $cursor, sortKey: UPDATED_AT, reverse: true) {
          edges { node {
            id name createdAt updatedAt
            totalPriceSet { shopMoney { amount currencyCode } }
            fulfillments { status createdAt trackingInfo(first: 1) { number company } }
            lineItems(first: 20) { edges { node { title quantity sku image { url } variant { image { url } } } } }
          } }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { cursor }
    );
    const edges = data.orders.edges;
    if (!edges.length) break;
    let sawOld = false;
    for (const { node: o } of edges) {
      if (new Date(o.updatedAt) < new Date(startIso)) { sawOld = true; continue; }
      for (const f of o.fulfillments) {
        if (f.status !== 'SUCCESS') continue;
        const tracking = f.trackingInfo[0];
        if (!tracking || !/sameday/i.test(tracking.company || '')) continue;
        if (new Date(f.createdAt).toLocaleDateString('en-CA', { timeZone: 'Europe/Bucharest' }) !== todayKey) continue;
        const existing = db.getAwb(tracking.number);
        if (existing) continue;
        db.upsertAwb({
          awb: tracking.number,
          order_name: o.name,
          order_created_at: o.createdAt,
          awb_created_at: f.createdAt,
          total: parseFloat(o.totalPriceSet.shopMoney.amount),
          currency: o.totalPriceSet.shopMoney.currencyCode,
          order_id: o.id ? o.id.split('/').pop() : null,
          items: o.lineItems.edges.map((e) => ({
            title: e.node.title,
            qty: e.node.quantity,
            sku: e.node.sku,
            img: (e.node.image && e.node.image.url) || (e.node.variant && e.node.variant.image && e.node.variant.image.url) || null,
          })),
        });
        added++;
      }
    }
    if (!data.orders.pageInfo.hasNextPage || sawOld) break;
    cursor = data.orders.pageInfo.endCursor;
  }
  if (added) {
    console.log(`[backfill] added ${added} AWB(s) missed by webhooks`);
    broadcast({ type: 'refresh' }); // simplest: tell clients to re-fetch today
  }
  return added;
}

// Same crawl as backfillToday(), but over the last `daysBack` days instead of
// just today, and without the "must be Sameday-created today" restriction —
// used for the one-time manual catch-up via /admin/backfill-old.
async function backfillRange(daysBack, debug) {
  const cutoffMs = Date.now() - daysBack * 24 * 3600 * 1000;
  let cursor = null;
  let added = 0;
  const stats = { ordersScanned: 0, fulfillmentsSuccess: 0, samedayMatches: 0, alreadyInDb: 0, pages: 0 };
  for (let page = 0; page < 60; page++) {
    stats.pages++;
    const data = await shopify.shopifyGraphql(
      `query($cursor: String) {
        orders(first: 50, after: $cursor, sortKey: UPDATED_AT, reverse: true) {
          edges { node {
            id name createdAt updatedAt
            totalPriceSet { shopMoney { amount currencyCode } }
            fulfillments { status createdAt trackingInfo(first: 1) { number company } }
            lineItems(first: 20) { edges { node { title quantity sku image { url } variant { image { url } } } } }
          } }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { cursor }
    );
    const edges = data.orders.edges;
    if (!edges.length) break;
    let sawOld = false;
    for (const { node: o } of edges) {
      stats.ordersScanned++;
      if (new Date(o.updatedAt).getTime() < cutoffMs) { sawOld = true; continue; }
      for (const f of o.fulfillments) {
        if (f.status !== 'SUCCESS') continue;
        if (new Date(f.createdAt).getTime() < cutoffMs) continue;
        stats.fulfillmentsSuccess++;
        const tracking = f.trackingInfo[0];
        if (!tracking || !/sameday/i.test(tracking.company || '')) continue;
        stats.samedayMatches++;
        const existing = db.getAwb(tracking.number);
        if (existing) { stats.alreadyInDb++; continue; }
        db.upsertAwb({
          awb: tracking.number,
          order_name: o.name,
          order_created_at: o.createdAt,
          awb_created_at: f.createdAt,
          total: parseFloat(o.totalPriceSet.shopMoney.amount),
          currency: o.totalPriceSet.shopMoney.currencyCode,
          order_id: o.id ? o.id.split('/').pop() : null,
          items: o.lineItems.edges.map((e) => ({
            title: e.node.title,
            qty: e.node.quantity,
            sku: e.node.sku,
            img: (e.node.image && e.node.image.url) || (e.node.variant && e.node.variant.image && e.node.variant.image.url) || null,
          })),
        });
        added++;
      }
    }
    if (!data.orders.pageInfo.hasNextPage || sawOld) break;
    cursor = data.orders.pageInfo.endCursor;
  }
  if (added) console.log(`[backfill-old] added ${added} AWB(s) from the last ${daysBack} day(s)`);
  return debug ? { added, stats } : added;
}

if (process.env.SHOPIFY_SHOP && process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET) {
  backfillToday().catch((err) => console.error('[backfill] startup run failed', err));
  setInterval(() => backfillToday().catch((err) => console.error('[backfill] error', err)), BACKFILL_INTERVAL_MS);
} else {
  console.warn('[backfill] SHOPIFY_SHOP / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET not set — skipping Shopify backfill (webhook-only mode)');
}

server.listen(PORT, () => {
  console.log(`AWB Glorio server listening on :${PORT}`);
});

// Last-resort safety net: log and keep running instead of crashing the
// whole process on an unexpected error (e.g. from a background poll tick).
process.on('uncaughtException', (err) => console.error('[fatal] uncaughtException', err));
process.on('unhandledRejection', (err) => console.error('[fatal] unhandledRejection', err));
