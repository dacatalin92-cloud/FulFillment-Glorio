<!doctype html>
<html lang="ro">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Monitor Depozit — Glorio</title>
<style>
  :root {
    --bg: #0f1117;
    --card: #1a1d27;
    --border: #2a2d3a;
    --text: #e8eaf0;
    --muted: #7a7f96;
    --green: #22c55e;
    --blue: #3b82f6;
    --orange: #f59e0b;
    --red: #ef4444;
    --purple: #a855f7;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Segoe UI', system-ui, sans-serif;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    padding: 24px;
    gap: 20px;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }
  header h1 {
    font-size: 1.3rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
  }
  #clock {
    font-size: 1.5rem;
    font-weight: 700;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  #date-label {
    font-size: 0.9rem;
    color: var(--muted);
    text-align: right;
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 24px 28px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .card .label {
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--muted);
    font-weight: 600;
  }
  .card .count {
    font-size: 4rem;
    font-weight: 800;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }
  .card .value {
    font-size: 1.35rem;
    font-weight: 700;
    color: var(--text);
    margin-top: 6px;
    font-variant-numeric: tabular-nums;
  }
  .card.total .count { color: var(--green); }
  .card.bok    .count { color: var(--blue); }
  .card.dpd    .count { color: var(--orange); }
  .card.sameday .count { color: var(--purple); }
  .card.unscan .count { color: var(--red); }

  .section-title {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
    font-weight: 600;
    margin-bottom: -4px;
  }

  .feed {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
    flex: 1;
  }
  .feed-header {
    padding: 14px 20px;
    border-bottom: 1px solid var(--border);
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--muted);
    font-weight: 600;
  }
  .feed-list {
    list-style: none;
    max-height: 320px;
    overflow-y: auto;
  }
  .feed-list li {
    display: grid;
    grid-template-columns: 60px 110px 1fr auto auto;
    gap: 12px;
    align-items: center;
    padding: 11px 20px;
    border-bottom: 1px solid var(--border);
    font-size: 0.88rem;
    transition: background 0.3s;
  }
  .feed-list li.new {
    background: rgba(34, 197, 94, 0.08);
  }
  .feed-list li .nr { color: var(--muted); font-size: 0.78rem; }
  .feed-list li .time { color: var(--muted); font-variant-numeric: tabular-nums; }
  .feed-list li .order { font-weight: 700; }
  .feed-list li .awb {
    font-family: 'Courier New', monospace;
    font-size: 0.8rem;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .badge {
    font-size: 0.7rem;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 20px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }
  .badge-bok     { background: rgba(59,130,246,0.18); color: #60a5fa; }
  .badge-dpd     { background: rgba(245,158,11,0.18); color: #fbbf24; }
  .badge-sameday { background: rgba(168,85,247,0.18); color: #c084fc; }
  .badge-other   { background: rgba(122,127,150,0.18); color: #a0a5b8; }

  #status {
    font-size: 0.75rem;
    color: var(--muted);
    text-align: center;
  }
  #status.ok { color: var(--green); }
  #status.err { color: var(--red); }

  /* ── Products view ───────────────────────────────────────────────────── */
  .prod-row {
    padding: 12px 20px;
    border-bottom: 1px solid var(--border);
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 8px 16px;
    align-items: start;
  }
  .prod-row .prod-title {
    font-weight: 700;
    font-size: 0.92rem;
    grid-column: 1;
  }
  .prod-row .prod-badge {
    grid-column: 2;
    grid-row: 1 / span 2;
    align-self: center;
    font-size: 1.6rem;
    font-weight: 800;
    color: var(--green);
    font-variant-numeric: tabular-nums;
    text-align: right;
    white-space: nowrap;
  }
  .prod-row .prod-orders {
    grid-column: 1;
    font-size: 0.78rem;
    color: var(--muted);
    line-height: 1.6;
  }
  .prod-row .prod-orders .ord-chip {
    display: inline-block;
    background: rgba(59,130,246,0.12);
    color: #60a5fa;
    border-radius: 6px;
    padding: 1px 7px;
    margin: 2px 3px 2px 0;
    font-size: 0.75rem;
    font-weight: 600;
  }
  .prod-row.dup .prod-title { color: var(--orange); }

  @media (max-width: 600px) {
    body { padding: 12px; gap: 12px; }
    .card .count { font-size: 3rem; }
    .feed-list li { grid-template-columns: 50px 1fr auto; }
    .feed-list li .awb, .feed-list li .time { display: none; }
  }
</style>
</head>
<body>

<header>
  <h1>📦 Monitor Depozit</h1>
  <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;justify-content:flex-end">
    <div style="display:flex;align-items:center;gap:6px">
      <button id="btn-prev" onclick="changeDay(-1)" style="background:var(--card);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:6px 12px;font-size:1.1rem;cursor:pointer;">‹</button>
      <input type="date" id="day-picker" style="background:var(--card);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:6px 10px;font-size:0.9rem;cursor:pointer;" onchange="loadDay(this.value)">
      <button id="btn-next" onclick="changeDay(1)" style="background:var(--card);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:6px 12px;font-size:1.1rem;cursor:pointer;">›</button>
      <button onclick="goToday()" id="btn-today" style="background:var(--green);border:none;color:#000;border-radius:8px;padding:6px 12px;font-size:0.8rem;font-weight:700;cursor:pointer;letter-spacing:0.04em;">AZI</button>
    </div>
    <div style="text-align:right">
      <div id="clock">--:--:--</div>
      <div id="date-label">--</div>
    </div>
  </div>
</header>

<div class="cards">
  <div class="card total">
    <div class="label">✅ Total confirmate azi</div>
    <div class="count" id="cnt-total">—</div>
    <div class="value" id="val-total"></div>
  </div>
  <div class="card bok">
    <div class="label">🔵 Bookurier</div>
    <div class="count" id="cnt-bok">—</div>
    <div class="value" id="val-bok"></div>
  </div>
  <div class="card dpd">
    <div class="label">🟡 DPD</div>
    <div class="count" id="cnt-dpd">—</div>
    <div class="value" id="val-dpd"></div>
  </div>
  <div class="card sameday">
    <div class="label">🟣 Sameday</div>
    <div class="count" id="cnt-smd">—</div>
    <div class="value" id="val-smd"></div>
  </div>
</div>

<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
  <div class="section-title" id="section-label">Ultimele scanări confirmate</div>
  <div style="display:flex;gap:8px">
    <button id="btn-view-feed" onclick="setView('feed')" style="background:var(--blue);border:none;color:#fff;border-radius:8px;padding:6px 14px;font-size:0.78rem;font-weight:700;cursor:pointer;letter-spacing:0.04em;">📋 Scanări</button>
    <button id="btn-view-prod" onclick="setView('products')" style="background:var(--card);border:1px solid var(--border);color:var(--muted);border-radius:8px;padding:6px 14px;font-size:0.78rem;font-weight:700;cursor:pointer;letter-spacing:0.04em;">📦 Produse</button>
  </div>
</div>

<div class="feed" id="panel-feed">
  <div class="feed-header">Flux live — scanări confirmate (împachetate)</div>
  <ul class="feed-list" id="feed"></ul>
</div>

<div class="feed" id="panel-products" style="display:none">
  <div class="feed-header">Produse împachetate azi — grupate după titlu</div>
  <div id="prod-list" style="overflow-y:auto;max-height:420px"></div>
</div>

<div id="status">Se conectează…</div>

<script>
  // ── Helpers ──────────────────────────────────────────────────────────────
  const tz = 'Europe/Bucharest';

  function todayStr() {
    return new Date().toLocaleDateString('en-CA', { timeZone: tz });
  }

  function fmtTime(iso) {
    return new Date(iso).toLocaleTimeString('ro-RO', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function courierOf(awb) {
    if (/BOK|B0K/i.test(awb))    return 'bok';
    if (/^1ONB/i.test(awb))      return 'sameday';
    if (/^\d{10,14}$/.test(awb)) return 'dpd';
    return 'other';
  }

  function badgeHtml(courier) {
    const map = { bok: 'Bookurier', dpd: 'DPD', sameday: 'Sameday', other: '?' };
    return `<span class="badge badge-${courier}">${map[courier] || courier}</span>`;
  }

  // ── Clock ─────────────────────────────────────────────────────────────────
  function tickClock() {
    const now = new Date();
    document.getElementById('clock').textContent =
      now.toLocaleTimeString('ro-RO', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    document.getElementById('date-label').textContent =
      now.toLocaleDateString('ro-RO', { timeZone: tz, day: '2-digit', month: 'long', year: 'numeric' });
  }
  setInterval(tickClock, 1000);
  tickClock();

  // ── State ─────────────────────────────────────────────────────────────────
  let allPacked = [];   // all confirmed rows for current viewed day
  let viewedDay = todayStr();  // which day we're looking at

  // ── Day navigation ────────────────────────────────────────────────────────
  function initPicker() {
    const picker = document.getElementById('day-picker');
    picker.value = viewedDay;
    picker.max = todayStr();
    updateTodayBtn();
  }

  function updateTodayBtn() {
    const isToday = viewedDay === todayStr();
    const btn = document.getElementById('btn-today');
    btn.style.opacity = isToday ? '0.4' : '1';
    btn.style.cursor  = isToday ? 'default' : 'pointer';
  }

  async function loadDay(dateStr) {
    viewedDay = dateStr;
    document.getElementById('day-picker').value = dateStr;
    document.getElementById('day-picker').max = todayStr();
    updateTodayBtn();
    // Clear while loading
    document.getElementById('cnt-total').textContent = '…';
    document.getElementById('feed').innerHTML = '';
    try {
      const res = await fetch(`/api/packed-day/${dateStr}`);
      const data = await res.json();
      allPacked = (data.rows || []).filter(r => r.packed && !r.cancelled);
      updateCounters();
      renderFeed();
      if (currentView === 'products') renderProducts();
    } catch (e) {
      console.error('loadDay error', e);
    }
  }

  function changeDay(delta) {
    const d = new Date(viewedDay + 'T12:00:00');
    d.setDate(d.getDate() + delta);
    const next = d.toLocaleDateString('en-CA', { timeZone: tz });
    if (next > todayStr()) return;   // can't go into the future
    loadDay(next);
  }

  function goToday() {
    if (viewedDay === todayStr()) return;
    loadDay(todayStr());
  }

  function updateCounters() {
    const rows = allPacked;
    const bok = rows.filter(r => courierOf(r.awb) === 'bok');
    const dpd = rows.filter(r => courierOf(r.awb) === 'dpd');
    const smd = rows.filter(r => courierOf(r.awb) === 'sameday');

    const sum = arr => arr.reduce((s, r) => s + (r.cod ?? r.total ?? 0), 0);

    document.getElementById('cnt-total').textContent = rows.length;
    document.getElementById('val-total').textContent = sum(rows).toFixed(2) + ' RON';
    document.getElementById('cnt-bok').textContent = bok.length;
    document.getElementById('val-bok').textContent = bok.length ? sum(bok).toFixed(2) + ' RON' : '';
    document.getElementById('cnt-dpd').textContent = dpd.length;
    document.getElementById('val-dpd').textContent = dpd.length ? sum(dpd).toFixed(2) + ' RON' : '';
    document.getElementById('cnt-smd').textContent = smd.length;
    document.getElementById('val-smd').textContent = smd.length ? sum(smd).toFixed(2) + ' RON' : '';
  }

  // ── View toggle ───────────────────────────────────────────────────────────
  let currentView = 'feed';

  function setView(v) {
    currentView = v;
    const isFeed = v === 'feed';
    document.getElementById('panel-feed').style.display     = isFeed ? '' : 'none';
    document.getElementById('panel-products').style.display = isFeed ? 'none' : '';
    document.getElementById('btn-view-feed').style.background = isFeed ? 'var(--blue)' : 'var(--card)';
    document.getElementById('btn-view-feed').style.color      = isFeed ? '#fff' : 'var(--muted)';
    document.getElementById('btn-view-feed').style.border     = isFeed ? 'none' : '1px solid var(--border)';
    document.getElementById('btn-view-prod').style.background = isFeed ? 'var(--card)' : 'var(--orange)';
    document.getElementById('btn-view-prod').style.color      = isFeed ? 'var(--muted)' : '#000';
    document.getElementById('btn-view-prod').style.border     = isFeed ? '1px solid var(--border)' : 'none';
    document.getElementById('section-label').textContent = isFeed
      ? 'Ultimele scanări confirmate'
      : 'Produse împachetate — grupate după titlu';
    if (v === 'products') renderProducts();
  }

  // ── Products view ─────────────────────────────────────────────────────────
  function parseItems(row) {
    try {
      const raw = row.items;
      if (!raw) return [];
      if (Array.isArray(raw)) return raw;
      return JSON.parse(raw);
    } catch { return []; }
  }

  function renderProducts() {
    // Build map: product key → { title, variant, orders: [{name, qty, awb}] }
    const map = new Map();

    for (const row of allPacked) {
      const items = parseItems(row);
      if (!items.length) {
        // Fallback: no items stored — just show order name
        const key = '(produs necunoscut)';
        if (!map.has(key)) map.set(key, { title: key, variant: '', orders: [] });
        map.get(key).orders.push({ name: row.order_name || row.awb, qty: 1, awb: row.awb });
        continue;
      }
      for (const it of items) {
        const title   = it.title || '?';
        const variant = it.variant && it.variant !== 'Default Title' ? it.variant : '';
        const key     = title + (variant ? ' · ' + variant : '');
        if (!map.has(key)) map.set(key, { title, variant, orders: [] });
        map.get(key).orders.push({
          name: row.order_name || row.awb,
          qty:  it.qty || 1,
          awb:  row.awb
        });
      }
    }

    // Sort: most duplicated first, then alphabetical
    const sorted = [...map.entries()].sort((a, b) => {
      const diff = b[1].orders.length - a[1].orders.length;
      return diff !== 0 ? diff : a[0].localeCompare(b[0], 'ro');
    });

    const container = document.getElementById('prod-list');
    if (!sorted.length) {
      container.innerHTML = '<div style="padding:20px;color:var(--muted);text-align:center">Nicio scanare</div>';
      return;
    }

    container.innerHTML = sorted.map(([key, { title, variant, orders }]) => {
      const totalQty = orders.reduce((s, o) => s + o.qty, 0);
      const isDup    = orders.length > 1;
      // Chips for each order (show order name + qty if qty>1)
      const chips = orders.map(o =>
        `<span class="ord-chip">${o.name}${o.qty > 1 ? ' ×' + o.qty : ''}</span>`
      ).join('');
      const variantLine = variant ? `<span style="color:var(--muted);font-size:0.78rem"> — ${variant}</span>` : '';
      return `<div class="prod-row${isDup ? ' dup' : ''}">
        <div class="prod-title">${title}${variantLine}</div>
        <div class="prod-badge">${totalQty}</div>
        <div class="prod-orders">${chips}</div>
      </div>`;
    }).join('');
  }

  function renderFeed() {
    const sorted = [...allPacked].sort((a, b) =>
      (b.packed_at || '').localeCompare(a.packed_at || ''));
    const recent = sorted.slice(0, 30);
    const feed = document.getElementById('feed');
    feed.innerHTML = recent.map((r, i) => {
      const c = courierOf(r.awb);
      return `<li>
        <span class="nr">${allPacked.length - i}</span>
        <span class="time">${r.packed_at ? fmtTime(r.packed_at) : '—'}</span>
        <span class="order">${r.order_name || ''}</span>
        <span class="awb">${r.awb}</span>
        ${badgeHtml(c)}
      </li>`;
    }).join('');
  }

  // ── Load data ─────────────────────────────────────────────────────────────
  function loadToday() { loadDay(todayStr()); }

  initPicker();
  loadDay(viewedDay);
  // Refresh every 2 minutes — only reloads data for the currently viewed day
  setInterval(() => loadDay(viewedDay), 120_000);

  // ── WebSocket — real-time updates ─────────────────────────────────────────
  let ws, wsRetries = 0;

  function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);

    ws.onopen = () => {
      wsRetries = 0;
      document.getElementById('status').textContent = '🟢 Live — actualizare în timp real';
      document.getElementById('status').className = 'ok';
    };

    ws.onmessage = (evt) => {
      // Live updates only matter when watching today
      if (viewedDay !== todayStr()) return;
      try {
        const msg = JSON.parse(evt.data);
        // A confirmed pack scan
        if (msg.result && msg.result.kind === 'packed' && msg.result.row) {
          const row = msg.result.row;
          const packedDay = row.packed_at
            ? new Date(row.packed_at).toLocaleDateString('en-CA', { timeZone: tz })
            : null;
          if (packedDay === todayStr()) {
            // Add or update in allPacked
            const idx = allPacked.findIndex(r => r.awb === row.awb);
            if (idx >= 0) allPacked[idx] = row;
            else allPacked.push(row);
            updateCounters();
            renderFeed();
            if (currentView === 'products') renderProducts();
            // Flash new row
            const items = document.querySelectorAll('#feed li');
            if (items[0]) {
              items[0].classList.add('new');
              setTimeout(() => items[0].classList.remove('new'), 3000);
            }
          }
        }
        // Reload on any scan to catch edge cases
        if (msg.result && (msg.result.kind === 'packed' || msg.result.kind === 'already')) {
          loadDay(todayStr());
        }
      } catch {}
    };

    ws.onclose = () => {
      const delay = Math.min(1000 * 2 ** wsRetries++, 30000);
      document.getElementById('status').textContent = `🔴 Deconectat — reconectare în ${Math.round(delay/1000)}s…`;
      document.getElementById('status').className = 'err';
      setTimeout(connectWs, delay);
    };

    ws.onerror = () => ws.close();
  }

  connectWs();
</script>
</body>
</html>
