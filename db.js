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

// A physical return can arrive at the warehouse for a code that isn't in
// `awbs` at all (not a Sameday AWB we ever tracked, a typo, a return from
// another channel). Those need a flag of their own so they don't just
// disappear as a silent 404 — logged here for manual follow-up.
db.exec(`
CREATE TABLE IF NOT EXISTS unknown_returns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  scanned_at TEXT NOT NULL,
  note TEXT DEFAULT '',
  resolved INTEGER NOT NULL DEFAULT 0,
  resolved_at TEXT
);
`);

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
  // Used for the Sameday reconciliation pass — marks packed WITHOUT touching
  // first_scan_at (unlike the old, removed setPackedFromCourier), so a
  // reconciled row is never mistaken for a manually-scanned one again (see
  // findFalsePackedCandidates, which fingerprints "auto" rows by
  // first_scan_at === packed_at). Reconciled rows keep first_scan_at NULL.
  setPackedFromReconciliation: db.prepare('UPDATE awbs SET packed = 1, packed_at = ? WHERE awb = ?'),
  cancelledAwbsForOrder: db.prepare('SELECT awb FROM awbs WHERE order_id = ? AND cancelled = 0'),
  cancelOrder: db.prepare('UPDATE awbs SET cancelled = 1 WHERE order_id = ?'),
  setNote: db.prepare('UPDATE awbs SET note = ? WHERE awb = ?'),
  findByCodeFuzzy: db.prepare("SELECT * FROM awbs WHERE ? LIKE awb || '%' OR awb LIKE ? || '%' LIMIT 1"),
  // Anything Sameday has flagged as a return in progress (status text
  // contains "retur" — covers "Retur", "Returnat", "Returnata" etc.) that we
  // haven't yet confirmed as physically back in the warehouse.
  listPendingReturns: db.prepare("SELECT * FROM awbs WHERE return_received = 0 AND LOWER(sameday_status) LIKE '%retur%' ORDER BY sameday_checked_at DESC"),
  setReturnReceived: db.prepare('UPDATE awbs SET return_received = 1, return_received_at = ? WHERE awb = ?'),
  // History: returns already confirmed received, most recent first. Capped at
  // 200 — this is a "recent history" view, not a full archive browser.
  listReturnHistory: db.prepare('SELECT * FROM awbs WHERE return_received = 1 ORDER BY return_received_at DESC LIMIT 200'),
  insertUnknownReturn: db.prepare('INSERT INTO unknown_returns (code, scanned_at) VALUES (?, ?)'),
  getUnknownReturn: db.prepare('SELECT * FROM unknown_returns WHERE id = ?'),
  listUnknownReturns: db.prepare('SELECT * FROM unknown_returns WHERE resolved = 0 ORDER BY scanned_at DESC'),
  setUnknownReturnNote: db.prepare('UPDATE unknown_returns SET note = ? WHERE id = ?'),
  resolveUnknownReturn: db.prepare('UPDATE unknown_returns SET resolved = 1, resolved_at = ? WHERE id = ?'),
  // History: unknown-return entries already resolved, most recent first.
  listResolvedUnknownReturns: db.prepare('SELECT * FROM unknown_returns WHERE resolved = 1 ORDER BY resolved_at DESC LIMIT 200'),
  // Dashboard "packed/shipped" view is grouped by the day the parcel was
  // actually PACKED (packed_at), not the day the AWB was generated (day).
  // Grouping by Bucharest day happens in JS below since packed_at is a raw
  // ISO timestamp and doing timezone-correct day-bucketing in SQL is fragile.
  listPackedRaw: db.prepare('SELECT * FROM awbs WHERE packed = 1 AND cancelled = 0'),
  countUnpacked: db.prepare('SELECT COUNT(*) AS c FROM awbs WHERE packed = 0 AND cancelled = 0'),
  // Reconciliation candidates: everything still unpacked in this app. Some of
  // these were genuinely packed and shipped through the other, older
  // fulfillment process — for those, Sameday's status is the only source of
  // truth, since no one will ever scan them at this app's station.
  listUnpackedNotCancelled: db.prepare('SELECT * FROM awbs WHERE packed = 0 AND cancelled = 0'),
  // One-off cleanup support for the removed auto-pack-from-courier feature
  // (see server.js applySamedayUpdate) — finds/reverts AWBs it wrongly
  // marked packed. Includes cancelled rows too, unlike listPackedRaw, since
  // a since-cancelled AWB could still carry the bad packed flag.
  listAllPacked: db.prepare('SELECT * FROM awbs WHERE packed = 1'),
  resetPacked: db.prepare('UPDATE awbs SET packed = 0, packed_at = NULL, first_scan_at = NULL WHERE awb = ?'),
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

// History view: AWBs already confirmed as physically received back,
// most recent first — separate from listPendingReturns() which only shows
// ones still waiting for confirmation.
function listReturnHistory() {
  return stmts.listReturnHistory.all();
}

// Logged when a return-mode scan doesn't match any known AWB — a physical
// box arrived at the warehouse for a code the system has no record of at
// all (different courier, older order, typo, damaged label). Kept separate
// from `awbs` since there's no order to attach it to.
function logUnknownReturn(code, whenIso) {
  const info = stmts.insertUnknownReturn.run(code, whenIso);
  return stmts.getUnknownReturn.get(info.lastInsertRowid);
}

function listUnknownReturns() {
  return stmts.listUnknownReturns.all();
}

function setUnknownReturnNote(id, note) {
  stmts.setUnknownReturnNote.run(note, id);
  return stmts.getUnknownReturn.get(id);
}

// Marks an unknown-return entry as handled (matched manually, resolved,
// discarded) so it drops off the alert list.
function resolveUnknownReturn(id, whenIso) {
  stmts.resolveUnknownReturn.run(whenIso, id);
  return stmts.getUnknownReturn.get(id);
}

// History view: unknown-return entries already resolved, most recent first.
function listResolvedUnknownReturns() {
  return stmts.listResolvedUnknownReturns.all();
}

// --- Dashboard "packed/shipped" view — grouped by PACK date, not AWB ------
// creation date. An AWB generated on the 5th but scanned/packed today must
// show up under today here, and an AWB generated today but not yet packed
// must NOT show up under today — the opposite of scan.html's picking list,
// which is intentionally grouped by AWB creation date instead.
function listPackedDays() {
  const days = new Set();
  for (const row of stmts.listPackedRaw.all()) {
    if (row.packed_at) days.add(bucharestDay(row.packed_at));
  }
  return Array.from(days).sort().reverse();
}

function listPackedForDay(day) {
  return stmts.listPackedRaw.all()
    .filter((row) => row.packed_at && bucharestDay(row.packed_at) === day)
    .sort((a, b) => new Date(a.packed_at).getTime() - new Date(b.packed_at).getTime());
}

// Count of AWBs still not packed (and not cancelled) — used by the dashboard
// stat card now that its main row-fetch is scoped to a single packed day and
// can no longer be used to derive this count itself.
function countUnpacked() {
  return stmts.countUnpacked.get().c;
}

// One-off cleanup for the removed auto-pack-from-courier feature: it used to
// set packed_at and first_scan_at to the EXACT SAME timestamp whenever it
// marked an AWB packed without a real prior scan (see the old
// setPackedFromCourier statement). A genuine manual pack confirmation always
// has two distinct scans, so first_scan_at === packed_at is a reliable
// fingerprint of "the system did this, not a person". Restricting to AWBs
// packed shortly (maxAgeMinutes) after their own creation narrows this to
// the specific incident reported — AWBs showing packed within moments of
// printing the label — without touching older, unrelated packed rows.
function findFalsePackedCandidates(maxAgeMinutes) {
  const maxAgeMs = maxAgeMinutes * 60 * 1000;
  return stmts.listAllPacked.all().filter((row) => {
    if (!row.packed_at || !row.first_scan_at || row.packed_at !== row.first_scan_at) return false;
    const ageMs = new Date(row.packed_at).getTime() - new Date(row.awb_created_at).getTime();
    return ageMs >= 0 && ageMs <= maxAgeMs;
  });
}

function resetFalsePacked(awbs) {
  return awbs.map((awb) => {
    stmts.resetPacked.run(awb);
    return getAwb(awb);
  });
}

// All AWBs still unpacked in this app, for the reconciliation pass — the
// actual "does Sameday's status mean it genuinely left?" judgment call and
// the age-safety guard both live in server.js (reconcileWithSameday), since
// that's where the Sameday status-text knowledge already lives; this just
// hands back the full candidate pool.
function listUnpackedNotCancelled() {
  return stmts.listUnpackedNotCancelled.all();
}

// Marks an AWB packed from Sameday reconciliation — i.e. we never got (or
// will never get) a manual scan for it, but Sameday's own tracking shows a
// courier scan/pickup already happened, so it's certainly packed in
// reality. Deliberately does NOT touch first_scan_at (stays NULL), unlike a
// real scan-confirmed pack — that keeps this permanently distinguishable
// from a genuine station scan, including from the old buggy auto-pack
// fingerprint (first_scan_at === packed_at) that findFalsePackedCandidates
// looks for.
function markPackedFromReconciliation(awb, whenIso) {
  const row = getAwb(awb);
  if (!row || row.packed) return row;
  stmts.setPackedFromReconciliation.run(whenIso, awb);
  return getAwb(awb);
}

module.exports = { db, bucharestDay, upsertAwb, getAwb, listDays, listForDay, updateSameday, markOrderCancelled, recordScan, setNote, findByCode, listPendingReturns, markReturnReceived, listReturnHistory, logUnknownReturn, listUnknownReturns, setUnknownReturnNote, resolveUnknownReturn, listResolvedUnknownReturns, listPackedDays, listPackedForDay, countUnpacked, findFalsePackedCandidates, resetFalsePacked, listUnpackedNotCancelled, markPackedFromReconciliation };
