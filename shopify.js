// Shopify webhook verification + Admin API enrichment.
// The fulfillment webhook payload only carries IDs and line-item text (no
// product images, no order total) — we fetch those via one GraphQL call per
// new fulfillment, using the Admin API access token from the custom app.
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

async function shopifyGraphql(query, variables) {
  const shop = process.env.SHOPIFY_SHOP; // e.g. glorio-ro.myshopify.com
  const token = process.env.SHOPIFY_ADMIN_TOKEN; // shpat_...
  const res = await fetch(`https://${shop}/admin/api/2024-10/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });
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
