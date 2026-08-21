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

function bucharestDay(isoString) {
  // en-CA locale formats as YYYY-MM-DD, which is exactly the sortable key we want.
  return new Date(isoString).toLocaleDateString('en-CA', { timeZone: 'Europe/Bucharest' });
}

const upsertStmt = db.prepare(`
INSERT INTO awbs (awb, day, order_name, order_created_at, awb_created_at, total, currency, items_json)
VALUES (@awb, @day, @order_name, @order_created_at, @awb_created_at, @total, @currency, @items_json)
ON CONFLICT(awb) DO UPDATE SET
  order_name = excluded.order_name,
  order_created_at = excluded.order_created_at,
  awb_created_at = excluded.awb_created_at,
  total = excluded.total,
  currency = excluded.currency,
  items_json = excluded.items_json
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
  });
  return getAwb(rec.awb);
}

function getAwb(awb) {
  return db.prepare('SELECT * FROM awbs WHERE awb = ?').get(awb);
}

function listDays() {
  return db.prepare('SELECT DISTINCT day FROM awbs ORDER BY day DESC').all().map((r) => r.day);
}

function listForDay(day) {
  return db.prepare('SELECT * FROM awbs WHERE day = ? ORDER BY awb_created_at ASC').all(day);
}

function updateSameday(awb, { status, statusLabel, state, cod, error }) {
  db.prepare(`
    UPDATE awbs SET sameday_status = ?, sameday_status_label = ?, sameday_state = ?,
      cod = COALESCE(?, cod), sameday_error = ?, sameday_checked_at = ?
    WHERE awb = ?
  `).run(status || null, statusLabel || null, state || null, cod ?? null, error || null, new Date().toISOString(), awb);
  return getAwb(awb);
}

function recordScan(awb, nowIso, packWindowMs) {
  const row = getAwb(awb);
  if (!row) return { found: false };
  if (row.packed) {
    return { found: true, row, kind: 'already', };
  }
  if (!row.first_scan_at) {
    db.prepare('UPDATE awbs SET first_scan_at = ? WHERE awb = ?').run(nowIso, awb);
    return { found: true, row: getAwb(awb), kind: 'first' };
  }
  const delta = new Date(nowIso).getTime() - new Date(row.first_scan_at).getTime();
  if (delta >= 0 && delta <= packWindowMs) {
    db.prepare('UPDATE awbs SET packed = 1, packed_at = ? WHERE awb = ?').run(nowIso, awb);
    return { found: true, row: getAwb(awb), kind: 'packed' };
  }
  db.prepare('UPDATE awbs SET first_scan_at = ? WHERE awb = ?').run(nowIso, awb);
  return { found: true, row: getAwb(awb), kind: 'reset' };
}

function setNote(awb, note) {
  db.prepare('UPDATE awbs SET note = ? WHERE awb = ?').run(note, awb);
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
  row = db.prepare('SELECT * FROM awbs WHERE ? LIKE awb || \'%\' OR awb LIKE ? || \'%\' LIMIT 1').get(code, code);
  return row || null;
}

module.exports = { db, bucharestDay, upsertAwb, getAwb, listDays, listForDay, updateSameday, recordScan, setNote, findByCode };
