// SQLite storage — one row per AWB. "day" is the Bucharest-calendar-day the
// AWB was GENERATED on (not when the order was placed), computed once at
// insert time so day queries stay a plain indexed lookup.
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.sqlite');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS awbs (
  awb TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  order_name TEXT NOT NULL,
  order_created_at TEXT NOT NULL,
  awb_created_at TEXT NOT NULL,
  total REAL,
  currency TEXT DEFAULT 'RON',
  cod REAL,
  sameday_status TEXT,
  sameday_status_label TEXT,
  sameday_state TEXT,
  sameday_checked_at TEXT,
  sameday_error TEXT,
  packed INTEGER NOT NULL DEFAULT 0,
  first_scan_at TEXT,
  packed_at TEXT,
  note TEXT DEFAULT '',
  items_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_awbs_day ON awbs(day);
`);

// Migration: add columns for order-cancellation tracking to a database that
// may already exist on disk (Railway volume persists across deploys, and
// CREATE TABLE IF NOT EXISTS above won't add new columns to it). Sameday
// does NOT auto-cancel the AWB when the Shopify order is cancelled, so we
// track this ourselves from the orders/cancelled webhook.
for (const stmt of [
  'ALTER TABLE awbs ADD COLUMN order_id TEXT',
  'ALTER TABLE awbs ADD COLUMN cancelled INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE awbs ADD COLUMN return_received INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE awbs ADD COLUMN return_received_at TEXT',
]) {
  try { db.exec(stmt); } catch (err) { /* column already exists — fine */ }
}
db.exec('CREATE INDEX IF NOT EXISTS idx_awbs_order_id ON awbs(order_id)');

function bucharestDay(isoString) {
  // en-CA locale formats as YYYY-MM-DD, which is exactly the sortable key we want.
  return new Date(isoString).toLocaleDateString('en-CA', { timeZone: 'Europe/Bucharest' });
}

// All statements are prepared ONCE here and reused for the lifetime of the
// process, instead of calling db.prepare() fresh inside every function call.
// With the Sameday poller now running near-continuously (every AWB, one
// query per status update), re-preparing a statement on every single call
// creates and destroys a native Statement object at very high frequency —
// that churn is what triggered a native crash (RemoveEnvironmentCleanupHook
// assertion inside better-sqlite3's Statement destructor) under load. Reusing
// cached statements avoids that churn entirely and is also just faster.
const stmts = {
  getAwb: db.prepare('SELECT * FROM awbs WHERE awb = ?'),
  listDays: db.prepare('SELECT DISTINCT day FROM awbs ORDER BY day DESC'),
  listForDay: db.prepare('SELECT * FROM awbs WHERE day = ? ORDER BY awb_created_at ASC'),
  updateSameday: db.prepare(`
    UPDATE awbs SET sameday_status = ?, sameday_status_label = ?, sameday_state = ?,
      cod = COALESCE(?, cod), sameday_error = ?, sameday_checked_at = ?
    WHERE awb = ?
  `),
  setFirstScan: db.prepare('UPDATE awbs SET first_scan_at = ? WHERE awb = ?'),
  setPacked: db.prepare('UPDATE awbs SET packed = 1, packed_at = ? WHERE awb = ?'),
  setPackedFromCourier: db.prepare(`
    UPDATE awbs SET packed = 1, packed_at = ?, first_scan_at = COALESCE(first_scan_at, ?)
    WHERE awb = ?
  `),
  cancelledAwbsForOrder: db.prepare('SELECT awb FROM awbs WHERE order_id = ? AND cancelled = 0'),
  cancelOrder: db.prepare('UPDATE awbs SET cancelled = 1 WHERE order_id = ?'),
  setNote: db.prepare('UPDATE awbs SET note = ? WHERE awb = ?'),
  findByCodeFuzzy: db.prepare("SELECT * FROM awbs WHERE ? LIKE awb || '%' OR awb LIKE ? || '%' LIMIT 1"),
  // Anything Sameday has flagged as a return in progress (status text
  // contains "retur" — covers "Retur", "Returnat", "Returnata" etc.) that we
  // haven't yet confirmed as physically back in the warehouse.
  listPendingReturns: db.prepare("SELECT * FROM awbs WHERE return_received = 0 AND LOWER(sameday_status) LIKE '%retur%' ORDER BY sameday_checked_at DESC"),
  setReturnReceived: db.prepare('UPDATE awbs SET return_received = 1, return_received_at = ? WHERE awb = ?'),
};

const upsertStmt = db.prepare(`
INSERT INTO awbs (awb, day, order_name, order_created_at, awb_created_at, total, currency, items_json, order_id)
VALUES (@awb, @day, @order_name, @order_created_at, @awb_created_at, @total, @currency, @items_json, @order_id)
ON CONFLICT(awb) DO UPDATE SET
  order_name = excluded.order_name,
  order_created_at = excluded.order_created_at,
  awb_created_at = excluded.awb_created_at,
  total = excluded.total,
  currency = excluded.currency,
  items_json = excluded.items_json,
  order_id = COALESCE(excluded.order_id, awbs.order_id)
`);

function upsertAwb(rec) {
  upsertStmt.run({
    awb: rec.awb,
    day: bucharestDay(rec.awb_created_at),
    order_name: rec.order_name,
    order_created_at: rec.order_created_at,
    awb_created_at: rec.awb_created_at,
    total: rec.total ?? null,
    currency: rec.currency || 'RON',
    items_json: JSON.stringify(rec.items || []),
    order_id: rec.order_id ? String(rec.order_id) : null,
  });
  return getAwb(rec.awb);
}

function getAwb(awb) {
  return stmts.getAwb.get(awb);
}

function listDays() {
  return stmts.listDays.all().map((r) => r.day);
}

function listForDay(day) {
  return stmts.listForDay.all(day);
}

function updateSameday(awb, { status, statusLabel, state, cod, error }) {
  stmts.updateSameday.run(status || null, statusLabel || null, state || null, cod ?? null, error || null, new Date().toISOString(), awb);
  return getAwb(awb);
}

function recordScan(awb, nowIso, packWindowMs) {
  const row = getAwb(awb);
  if (!row) return { found: false };
  if (row.cancelled) {
    return { found: true, row, kind: 'cancelled' };
  }
  if (row.packed) {
    return { found: true, row, kind: 'already', };
  }
  if (!row.first_scan_at) {
    stmts.setFirstScan.run(nowIso, awb);
    return { found: true, row: getAwb(awb), kind: 'first' };
  }
  const delta = new Date(nowIso).getTime() - new Date(row.first_scan_at).getTime();
  if (delta >= 0 && delta <= packWindowMs) {
    stmts.setPacked.run(nowIso, awb);
    return { found: true, row: getAwb(awb), kind: 'packed' };
  }
  stmts.setFirstScan.run(nowIso, awb);
  return { found: true, row: getAwb(awb), kind: 'reset' };
}

// Called when Sameday's status shows the parcel has already left our
// warehouse (picked up / in transit / delivered) — if we never got a manual
// pack-confirmation scan for it, mark it packed anyway so it doesn't sit in
// the picking list forever, and so a later accidental re-scan shows "already
// packed" instead of trying to pack it a second time.
function markPackedFromCourier(awb, whenIso) {
  const row = getAwb(awb);
  if (!row || row.packed) return row;
  stmts.setPackedFromCourier.run(whenIso, whenIso, awb);
  return getAwb(awb);
}

// Called from the orders/cancelled webhook. One order can (rarely) have more
// than one AWB (split fulfillments), so this cancels all of them and returns
// the updated rows for broadcasting. Sameday does NOT auto-cancel the AWB
// itself — this is purely our own "take it out of the packing flow" flag.
function markOrderCancelled(orderId) {
  const affected = stmts.cancelledAwbsForOrder.all(orderId).map((r) => r.awb);
  if (!affected.length) return [];
  stmts.cancelOrder.run(orderId);
  return affected.map((awb) => getAwb(awb));
}

function setNote(awb, note) {
  stmts.setNote.run(note, awb);
  return getAwb(awb);
}

function findByCode(code) {
  // Sameday label barcode = base AWB + 3-digit parcel suffix.
  let row = getAwb(code);
  if (row) return row;
  if (/^\d{3}$/.test(code.slice(-3))) {
    row = getAwb(code.slice(0, -3));
    if (row) return row;
  }
  row = stmts.findByCodeFuzzy.get(code, code);
  return row || null;
}

// All AWBs Sameday currently shows as "in return" (courier is bringing it
// back to us) that nobody has confirmed as physically received yet. Not
// scoped to a single day — a return can come back well after the AWB's
// original creation day.
function listPendingReturns() {
  return stmts.listPendingReturns.all();
}

// Manual confirmation that a returned parcel physically arrived back at the
// warehouse — separate from anything Sameday reports, since Sameday's own
// "return" status doesn't tell us it's actually back in our hands.
function markReturnReceived(awb, whenIso) {
  const row = getAwb(awb);
  if (!row) return null;
  if (row.return_received) return row;
  stmts.setReturnReceived.run(whenIso, awb);
  return getAwb(awb);
}

module.exports = { db, bucharestDay, upsertAwb, getAwb, listDays, listForDay, updateSameday, markPackedFromCourier, markOrderCancelled, recordScan, setNote, findByCode, listPendingReturns, markReturnReceived };
