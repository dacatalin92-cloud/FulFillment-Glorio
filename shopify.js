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

async function shopifyGraphql(query, variables) {
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
  const body = await res.json();
  if (body.errors) throw new Error('Shopify GraphQL error: ' + JSON.stringify(body.errors));
  return body.data;
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

module.exports = { verifyWebhookHmac, fetchOrderDetails, shopifyGraphql };
