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
      createdAt
      totalPriceSet { shopMoney { amount currencyCode } }
      lineItems(first: 20) {
        edges { node { title quantity sku image { url } variant { image { url } } } }
      }
    }
  }
`;

async function fetchOrderDetails(orderGid) {
  const data = await shopifyGraphql(ORDER_QUERY, { id: orderGid });
  const o = data.order;
  if (!o) return null;
  return {
    name: o.name,
    createdAt: o.createdAt,
    total: parseFloat(o.totalPriceSet.shopMoney.amount),
    currency: o.totalPriceSet.shopMoney.currencyCode,
    items: o.lineItems.edges.map((e) => ({
      title: e.node.title,
      qty: e.node.quantity,
      sku: e.node.sku,
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

module.exports = { verifyWebhookHmac, fetchOrderDetails, shopifyGraphql, findOrderIdByName };
