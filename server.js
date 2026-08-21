require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const db = require('./db');
const sameday = require('./sameday');
const shopify = require('./shopify');

const PORT = process.env.PORT || 3000;
const PACK_WINDOW_MS = 30000;
const SAMEDAY_POLL_MS = 2 * 60 * 1000; // 2 minutes — real courier status, not the bottleneck anymore
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

// --- Shopify webhook: fulfillments/create -----------------------------
// Needs the raw body for HMAC verification, so this route uses its own
// raw-body parser instead of the app-wide express.json().
app.post(
  '/webhooks/fulfillments-create',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const hmac = req.get('X-Shopify-Hmac-Sha256');
      const ok = shopify.verifyWebhookHmac(req.body, hmac, process.env.SHOPIFY_WEBHOOK_SECRET);
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
  });
  broadcast({ type: 'awb:new', awb: row });
  console.log(`[webhook] new AWB ${awb} for ${order.name}`);

  // Get a first real status right away instead of waiting for the next poll tick.
  try {
    const status = await sameday.getStatus(awb);
    const updated = db.updateSameday(awb, status);
    broadcast({ type: 'awb:update', awb: updated });
  } catch (err) {
    console.error(`[webhook] sameday status fetch failed for ${awb}`, err);
  }
}

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

// --- Sameday polling (courier status for open AWBs) ----------------------
sameday.startPoller(
  db,
  (awb, result) => {
    const row = db.updateSameday(awb, result);
    broadcast({ type: 'awb:update', awb: row });
  },
  SAMEDAY_POLL_MS
);

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
            name createdAt updatedAt
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

if (process.env.SHOPIFY_SHOP && process.env.SHOPIFY_ADMIN_TOKEN) {
  backfillToday().catch((err) => console.error('[backfill] startup run failed', err));
  setInterval(() => backfillToday().catch((err) => console.error('[backfill] error', err)), BACKFILL_INTERVAL_MS);
} else {
  console.warn('[backfill] SHOPIFY_SHOP / SHOPIFY_ADMIN_TOKEN not set — skipping Shopify backfill (webhook-only mode)');
}

server.listen(PORT, () => {
  console.log(`AWB Glorio server listening on :${PORT}`);
});

// Last-resort safety net: log and keep running instead of crashing the
// whole process on an unexpected error (e.g. from a background poll tick).
process.on('uncaughtException', (err) => console.error('[fatal] uncaughtException', err));
process.on('unhandledRejection', (err) => console.error('[fatal] unhandledRejection', err));
