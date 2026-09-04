// Shopify webhook verification + Admin API enrichment.
// The fulfillment webhook payload only carries IDs and line-item text (no
// product images, no order total) — we fetch those via one GraphQL call per
// new fulfillment.
//
// This app was created in the Shopify Dev Dashboard, which does NOT hand out
// a static Admin API access token to copy/paste. Instead the server itself
// exchanges Client ID + Client Secret for a short-lived token (~24h) via the
// OAuth client_credentials grant, and refreshes it automatically — same
// lazy-refresh-on-401 pattern as sameday.js.
const crypto = require('crypto');
const fetch = require('node-fetch');

function verifyWebhookHmac(rawBody, hmacHeader, secret) {
  if (!hmacHeader || !secret) return false;
  try {
    const digest = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  } catch {
    return false; // missing secret, length mismatch, bad encoding, etc.
  }
}

let adminToken = null;
let adminTokenExpiresAt = 0;

async function fetchAdminAccessToken() {
  const shop = process.env.SHOPIFY_SHOP;
  const client_id = process.env.SHOPIFY_CLIENT_ID;
  const client_secret = process.env.SHOPIFY_CLIENT_SECRET;
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id, client_secret, grant_type: 'client_credentials' }),
  });
  if (!res.ok) throw new Error(`Shopify token exchange failed: HTTP ${res.status}`);
  const body = await res.json();
  adminToken = body.access_token;
  // Token is valid ~24h (expires_in is in seconds, typically 86399) — refresh a bit early.
  const ttlMs = (body.expires_in || 86399) * 1000;
  adminTokenExpiresAt = Date.now() + ttlMs - 5 * 60 * 1000;
  return adminToken;
}

async function ensureAdminToken() {
  if (!adminToken || Date.now() > adminTokenExpiresAt) await fetchAdminAccessToken();
  return adminToken;
}

function isThrottled(body) {
  return Array.isArray(body.errors) && body.errors.some((e) => e.extensions && e.extensions.code === 'THROTTLED');
}

async function shopifyGraphqlOnce(query, variables) {
  const shop = process.env.SHOPIFY_SHOP; // e.g. glorio-ro.myshopify.com
  const token = await ensureAdminToken();
  let res = await fetch(`https://${shop}/admin/api/2024-10/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401) {
    // Token expired/revoked server-side — force a fresh exchange and retry once.
    await fetchAdminAccessToken();
    res = await fetch(`https://${shop}/admin/api/2024-10/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': adminToken,
      },
      body: JSON.stringify({ query, variables }),
    });
  }
  return res.json();
}

// Shopify's GraphQL Admin API is cost-based rate limited (a shared bucket
// that refills over time) — a big manual backfill can burn through it faster
// than it refills. Retry with backoff instead of failing the whole run.
async function shopifyGraphql(query, variables) {
  const MAX_ATTEMPTS = 6;
  let lastBody;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const body = await shopifyGraphqlOnce(query, variables);
    if (!isThrottled(body)) {
      if (body.errors) throw new Error('Shopify GraphQL error: ' + JSON.stringify(body.errors));
      return body.data;
    }
    lastBody = body;
    const waitMs = 1000 * attempt; // 1s, 2s, 3s, ... backing off as the bucket refills
    console.warn(`[shopify] throttled, retrying in ${waitMs}ms (attempt ${attempt}/${MAX_ATTEMPTS})`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  throw new Error('Shopify GraphQL error: ' + JSON.stringify(lastBody.errors));
}

const ORDER_QUERY = `
  query OrderForFulfillment($id: ID!) {
    order(id: $id) {
      name
      note
      createdAt
      phone
      shippingAddress { phone }
      totalPriceSet { shopMoney { amount currencyCode } }
      lineItems(first: 20) {
        edges { node { title quantity sku variantTitle image { url } variant { image { url } } customAttributes { key value } } }
      }
    }
  }
`;

// Some products carry their real specification (color, size, engraving text,
// etc.) not as a Shopify VARIANT at all, but as custom line-item PROPERTIES
// — set by a personalization app, a custom options app, or manual entry at
// checkout. variantTitle stays empty/"Default Title" for those, which is
// exactly the case reported as "specs not showing at the scan station" even
// after variant support was added. customAttributes carries that data — an
// internal bookkeeping key some apps add starts with "_" and is never meant
// for a human to see, so those are filtered out.
function extractProperties(customAttributes) {
  return (customAttributes || [])
    .filter((a) => a.key && !a.key.startsWith('_') && a.value)
    .map((a) => ({ key: a.key, value: a.value }));
}

async function fetchOrderDetails(orderGid) {
  const data = await shopifyGraphql(ORDER_QUERY, { id: orderGid });
  const o = data.order;
  if (!o) return null;
  return {
    name: o.name,
    note: o.note || '',
    createdAt: o.createdAt,
    // Prioritate: telefonul de pe adresa de livrare (cel mai probabil de
    // folosit de curier/staff pentru contact) > telefonul comenzii (cel
    // introdus la checkout). NU cerem și telefonul din contul clientului
    // (customer.phone) — necesită scope-ul `read_customers`, pe care
    // aplicația asta nu îl are; cererea către Shopify pică ÎN ÎNTREGIME
    // (nu doar câmpul respectiv) dacă îl includem, ceea ce a blocat sincronizarea
    // completă a AWB-urilor pentru o vreme (2026-09-04).
    phone: (o.shippingAddress && o.shippingAddress.phone) || o.phone || '',
    total: parseFloat(o.totalPriceSet.shopMoney.amount),
    currency: o.totalPriceSet.shopMoney.currencyCode,
    items: o.lineItems.edges.map((e) => ({
      title: e.node.title,
      qty: e.node.quantity,
      sku: e.node.sku,
      variant: e.node.variantTitle || '',
      props: extractProperties(e.node.customAttributes),
      img: (e.node.image && e.node.image.url) || (e.node.variant && e.node.variant.image && e.node.variant.image.url) || null,
    })),
  };
}

// Looks up an order's GID by its Shopify order name (e.g. "#16265") — used
// to backfill order_id on old AWB rows that predate order_id tracking (see
// server.js /admin/backfill-order-ids). Returns null if no exact match.
async function findOrderIdByName(orderName) {
  const data = await shopifyGraphql(
    `query($q: String!) { orders(first: 1, query: $q) { edges { node { id } } } }`,
    { q: `name:${orderName}` }
  );
  const edge = data.orders.edges[0];
  if (!edge) return null;
  return edge.node.id.split('/').pop();
}

// Shopify's Admin API has no mutation to post a staff "comment" into an
// order's Cronologie/Timeline the way a human does from the admin UI — that
// CommentEvent type is read-only from the API side. The closest workable
// substitute: append a timestamped line to the order's Note field (visible
// on the order page, and Shopify itself logs the note change as a timeline
// event) and add a tag. Both `note` and `tags` on orderUpdate OVERWRITE the
// existing value, so we read the current note/tags first and merge.
//
// The note LINE itself (e.g. "Scanat la depozit: 24.08.2026 14:32") is
// computed by the CALLER (server.js), at the moment of the scan, and passed
// in here as `line`. This function reads whatever is CURRENTLY in the
// order's Note field on Shopify, appends the line, writes it back, and
// returns { originalNote, fullNote }:
//   - originalNote: exactly what was there BEFORE we touched it (the
//     client's own note/instructions, if any — kept separate so it can be
//     shown to packing staff distinctly from our own confirmation line)
//   - fullNote: the merged text now actually saved in Shopify
const SCAN_TAG = 'scanat-depozit';
async function appendOrderScanNote(orderGid, line) {
  const data = await shopifyGraphql(
    `query($id: ID!) { order(id: $id) { note tags } }`,
    { id: orderGid }
  );
  const o = data.order;
  if (!o) return { originalNote: '', fullNote: line }; // order not found — best-effort fallback
  const originalNote = o.note || '';
  const newNote = originalNote ? `${originalNote}\n${line}` : line;
  const tags = Array.isArray(o.tags) ? o.tags.slice() : [];
  if (!tags.includes(SCAN_TAG)) tags.push(SCAN_TAG);
  const result = await shopifyGraphql(
    `mutation($input: OrderInput!) { orderUpdate(input: $input) { userErrors { field message } } }`,
    { input: { id: orderGid, note: newNote, tags } }
  );
  const errors = result.orderUpdate && result.orderUpdate.userErrors;
  if (errors && errors.length) throw new Error('orderUpdate userErrors: ' + JSON.stringify(errors));
  return { originalNote, fullNote: newNote };
}

// Lightweight, READ-ONLY fetch of just the order's current note — used to
// opportunistically re-check for a client note on scans AFTER the first one
// (see server.js /api/scan), since the note can be added to the order a few
// seconds after the very first scan (e.g. an operator typing it in while the
// AWB is already being handled at the station) and appendOrderScanNote only
// ever looks once, at first scan. Returns '' if the order isn't found.
async function fetchOrderNote(orderGid) {
  const data = await shopifyGraphql(
    `query($id: ID!) { order(id: $id) { note } }`,
    { id: orderGid }
  );
  return (data.order && data.order.note) || '';
}

module.exports = { verifyWebhookHmac, fetchOrderDetails, shopifyGraphql, findOrderIdByName, appendOrderScanNote, fetchOrderNote, extractProperties };
