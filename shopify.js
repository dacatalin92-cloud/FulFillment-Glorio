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
