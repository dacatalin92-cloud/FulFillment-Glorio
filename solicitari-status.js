'use strict';
// Read-only bridge for the authenticated Solicitari backend. No scan mutations.
const crypto = require('node:crypto');
function orderId(value) {
  const id = String(value || '').replace(/^gid:\/\/shopify\/Order\//, '');
  return /^\d{1,25}$/.test(id) ? id : null;
}
function normalizeOrders(body) {
  if (!Array.isArray(body?.orders) || body.orders.length < 1 || body.orders.length > 40) throw new Error('Expected 1–40 orders');
  const seen = new Set();
  return body.orders.map(o => {
    const id = orderId(o.order_id);
    if (!id || seen.has(id) || !/^#?\d{1,12}$/.test(o.order_name || '') || !Array.isArray(o.awbs) || o.awbs.length > 100) throw new Error('Invalid order');
    seen.add(id);
    const awbs = [...new Set(o.awbs.map(a => String(a || '').trim()))];
    if (awbs.some(a => !/^[A-Za-z0-9-]{5,60}$/.test(a))) throw new Error('Invalid AWB');
    return { order_id: id, order_name: o.order_name.replace(/^#/, ''), awbs };
  });
}
function publicParcel(row) {
  const scanned = Boolean(row.first_scan_at);
  // The old app can reconcile packed=1 from courier status without a scan.
  const scannedPacked = Boolean(row.packed && scanned && row.first_scan_at !== row.packed_at);
  const state = row.return_received ? 'return_received' : row.cancelled ? 'cancelled' : row.stock_missing ? 'stock_missing' : scannedPacked ? 'packed' : row.packed ? 'packed_unverified' : scanned ? 'scanned' : 'awaiting_scan';
  return {
    awb: row.awb, warehouse_state: state,
    first_scan_at: row.first_scan_at || null, packed_at: row.packed_at || null,
    stock_missing_at: row.stock_missing_at || null, return_received_at: row.return_received_at || null,
    cancelled: Boolean(row.cancelled), handoff_confirmed: false, operator: null,
    courier_status: {
      text: row.sameday_status || null, label: row.sameday_status_label || null,
      state: row.sameday_state || null, checked_at: row.sameday_checked_at || null,
      // Never expose provider error bodies, phone, notes, prices or items.
      unavailable: Boolean(row.sameday_error),
    },
  };
}
function snapshot(db, orders, now = new Date().toISOString()) {
  return { schema_version: 1, source: 'FulFillment-Glorio', checked_at: now, orders: orders.map(o => ({
    order_id: o.order_id,
    parcels: o.awbs.flatMap(awb => {
      // Deliberately exact. Scanner prefix/suffix/fuzzy matching is inappropriate here.
      const row = db.getAwb(awb);
      if (!row) return [];
      const linkedId = orderId(row.order_id);
      if (linkedId ? linkedId !== o.order_id : String(row.order_name || '').replace(/^#/, '') !== o.order_name) return [];
      return [publicParcel(row)];
    }),
  })) };
}
function authorized(header, secret) {
  if (typeof secret !== 'string' || secret.length < 32 || typeof header !== 'string' || header.length > 1024) return false;
  const actual = crypto.createHash('sha256').update(header).digest();
  const expected = crypto.createHash('sha256').update('Bearer ' + secret).digest();
  return crypto.timingSafeEqual(actual, expected);
}
function statusHandler(db, getSecret = () => process.env.SOLICITARI_STATUS_TOKEN) {
  return (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!authorized(req.get('authorization'), getSecret())) return res.status(401).json({ error: 'Unauthorized' });
    let orders;
    try { orders = normalizeOrders(req.body); } catch { return res.status(400).json({ error: 'Invalid order lookup' }); }
    try { return res.json(snapshot(db, orders)); } catch { return res.status(503).json({ error: 'Warehouse status unavailable' }); }
  };
}
module.exports = { orderId, normalizeOrders, publicParcel, snapshot, authorized, statusHandler };
