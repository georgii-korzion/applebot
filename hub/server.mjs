// Хаб (§5.1): общий сигнал OPEN, один наблюдатель на всех, победитель между профилями заказа,
// очередь оплаты между профилями, дашборд http://127.0.0.1:8765.
//   node hub/server.mjs            (HUB_PORT=8765 по умолчанию)
import http from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.HUB_PORT ?? 8765);
const HOST = process.env.HUB_HOST ?? '127.0.0.1';
const OFFLINE_FAIL_MS = 20_000;

const S = {
  openedAt: null,
  openSource: null,
  watcher: null,
  profiles: new Map(), // profile → { ws, orderId, priority, targets, tabs, stage, online, lastSeen }
  orders: new Map(),   // orderId → { winner, standby: [], failed: Set, stage, billingAt, orderNo }
  queue: [],           // [{ orderId, profile, priority, readyAt, store, slotLabel }]
  active: null,        // { orderId, profile, since }
  log: [],
};

const ts = () => new Date().toISOString().slice(11, 23);
function log(msg) {
  const line = `[${ts()}] [hub] ${msg}`;
  S.log.push(line);
  if (S.log.length > 3000) S.log.splice(0, S.log.length - 3000);
  console.log(line);
}
function send(ws, m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }
function toProfile(profile, m) { send(S.profiles.get(profile)?.ws, m); }
function broadcast(m) { for (const p of S.profiles.values()) send(p.ws, m); }
function order(id) {
  if (!S.orders.has(id)) S.orders.set(id, { winner: null, standby: [], failed: new Set(), stage: null, billingAt: null, orderNo: null });
  return S.orders.get(id);
}

function allTargets() {
  const t = new Set();
  for (const p of S.profiles.values()) for (const x of p.targets ?? []) t.add(x);
  return [...t];
}

function pickWatcher() {
  const cur = S.profiles.get(S.watcher);
  if (cur?.online) return;
  const next = [...S.profiles.entries()].find(([, p]) => p.online)?.[0] ?? null;
  if (next !== S.watcher) {
    S.watcher = next;
    log(`наблюдатель: ${next ?? '—'}`);
  }
}
function broadcastWatcher() {
  pickWatcher();
  broadcast({ t: 'WATCHER', profile: S.watcher, targets: allTargets() });
}

function activate() {
  if (S.active) return;
  const next = S.queue.shift();
  if (!next) return;
  S.active = { ...next, since: Date.now() };
  log(`очередь оплаты → заказ ${next.orderId} (${next.profile})`);
  toProfile(next.profile, { t: 'PAY_TURN', orderId: next.orderId, profile: next.profile });
}

function nextPay(reason) {
  if (S.active) log(`оплата: ${S.active.orderId}/${S.active.profile} → следующий (${reason})`);
  S.active = null;
  activate();
}

function failWinner(orderId, profile, reason) {
  const o = order(orderId);
  o.failed.add(profile);
  S.queue = S.queue.filter((q) => !(q.orderId === orderId && q.profile === profile));
  if (S.active?.orderId === orderId && S.active.profile === profile) nextPay('winner failed');
  if (o.winner !== profile) return;
  log(`заказ ${orderId}: победитель ${profile} упал (${reason})`);
  o.winner = null;
  while (o.standby.length) {
    const cand = o.standby.shift();
    if (o.failed.has(cand) || !S.profiles.get(cand)?.online) continue;
    o.winner = cand;
    log(`заказ ${orderId}: TAKEOVER → ${cand}`);
    toProfile(cand, { t: 'WIN', orderId, profile: cand, takeover: true });
    return;
  }
  log(`заказ ${orderId}: запасных нет — следующий WIN_REQ станет победителем`);
}

function onMsg(ws, m) {
  const p = ws.profile ? S.profiles.get(ws.profile) : null;
  if (p) p.lastSeen = Date.now();
  switch (m.t) {
    case 'REGISTER': {
      const prev = S.profiles.get(m.profile);
      if (prev?.ws && prev.ws !== ws) { try { prev.ws.close(); } catch { /* */ } }
      clearTimeout(prev?.offlineTimer);
      S.profiles.set(m.profile, { ...(prev ?? { tabs: [], stage: null }), ws, orderId: m.orderId, priority: m.priority, targets: m.targets ?? [], online: true, lastSeen: Date.now() });
      ws.profile = m.profile;
      log(`REGISTER ${m.profile} → заказ ${m.orderId ?? '—'}`);
      broadcastWatcher();
      if (S.openedAt) send(ws, { t: 'OPEN', at: S.openedAt, buyable: [], source: `hub:${S.openSource}` });
      break;
    }
    case 'OPEN':
      if (S.openedAt) break;
      S.openedAt = Date.now();
      S.openSource = `${m.profile}/${m.source}`;
      log(`OPEN от ${m.profile} (${m.source}), buyable: ${(m.buyable ?? []).join(',') || '—'}`);
      broadcast({ t: 'OPEN', at: S.openedAt, buyable: m.buyable ?? [], source: m.source });
      break;
    case 'WIN_REQ': {
      const o = order(m.orderId);
      if (!o.winner || o.winner === m.profile) {
        o.winner = m.profile;
        o.failed.delete(m.profile);
        log(`заказ ${m.orderId}: WIN → ${m.profile}`);
        send(ws, { t: 'WIN', orderId: m.orderId, profile: m.profile });
      } else {
        if (!o.standby.includes(m.profile)) o.standby.push(m.profile);
        log(`заказ ${m.orderId}: LOSE → ${m.profile} (STANDBY, победитель ${o.winner})`);
        send(ws, { t: 'LOSE', orderId: m.orderId });
        if (o.billingAt) send(ws, { t: 'CLEAN', orderId: m.orderId });
      }
      break;
    }
    case 'FAILED':
      failWinner(m.orderId, m.profile, m.reason);
      break;
    case 'PAY_READY': {
      const o = order(m.orderId);
      o.billingAt = Date.now();
      o.stage = 'BILLING_READY';
      S.queue = S.queue.filter((q) => !(q.orderId === m.orderId && q.profile === m.profile));
      S.queue.push({ orderId: m.orderId, profile: m.profile, priority: m.priority, readyAt: m.readyAt, store: m.store, slotLabel: m.slotLabel });
      S.queue.sort((a, b) => a.priority - b.priority || a.readyAt - b.readyAt);
      const t = S.openedAt ? ` (+${((Date.now() - S.openedAt) / 1000).toFixed(1)} с от OPEN)` : '';
      log(`заказ ${m.orderId}: BILLING_READY у ${m.profile} · ${m.store} · ${m.slotLabel}${t}`);
      for (const sp of o.standby) toProfile(sp, { t: 'CLEAN', orderId: m.orderId });
      activate();
      break;
    }
    case 'PAY_DONE':
      if (S.active && S.active.orderId === m.orderId && S.active.profile === m.profile) nextPay(m.stage);
      break;
    case 'NEXT':
      nextPay('кнопка «Следующий»');
      break;
    case 'ORDERED': {
      const o = order(m.orderId);
      o.orderNo = m.orderNo;
      o.stage = 'ORDERED';
      log(`заказ ${m.orderId}: ORDERED ${m.orderNo} (${m.profile})`);
      if (S.active && S.active.orderId === m.orderId) nextPay('ORDERED');
      break;
    }
    case 'STATUS':
      if (p) { p.tabs = m.tabs ?? []; p.stage = m.stage ?? null; p.orderId = m.orderId; }
      if (m.orderId && m.stage && order(m.orderId).winner === m.profile && order(m.orderId).stage !== 'ORDERED') order(m.orderId).stage = m.stage;
      break;
    case 'LOG':
      S.log.push(String(m.line));
      if (S.log.length > 3000) S.log.splice(0, S.log.length - 3000);
      break;
    case 'PING':
      send(ws, { t: 'PONG' });
      break;
  }
}

function onClose(ws) {
  const name = ws.profile;
  const p = name ? S.profiles.get(name) : null;
  if (!p || p.ws !== ws) return;
  p.online = false;
  p.ws = null;
  log(`${name} отключился`);
  broadcastWatcher();
  // победитель пропал надолго → передать заказ запасному
  p.offlineTimer = setTimeout(() => {
    if (p.online) return;
    for (const [id, o] of S.orders) if (o.winner === name && o.stage !== 'ORDERED') failWinner(id, name, 'профиль офлайн');
  }, OFFLINE_FAIL_MS);
}

function snapshot() {
  return {
    now: Date.now(),
    openedAt: S.openedAt,
    openSource: S.openSource,
    watcher: S.watcher,
    profiles: [...S.profiles.entries()].map(([name, p]) => ({ name, orderId: p.orderId, priority: p.priority, online: p.online, lastSeen: p.lastSeen, stage: p.stage, tabs: p.tabs })),
    orders: [...S.orders.entries()].map(([id, o]) => ({ id, winner: o.winner, standby: o.standby, failed: [...o.failed], stage: o.stage, billingAt: o.billingAt, orderNo: o.orderNo })),
    queue: S.queue,
    active: S.active,
    log: S.log.slice(-300),
  };
}

function reset() {
  S.openedAt = null; S.openSource = null; S.orders.clear(); S.queue = []; S.active = null; S.log = [];
  for (const p of S.profiles.values()) { p.tabs = []; p.stage = null; }
  log('состояние сброшено');
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'GET' && url.pathname === '/api/state') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(snapshot()));
  }
  if (req.method === 'POST' && url.pathname === '/api/next') { nextPay('дашборд'); res.writeHead(200); return res.end('ok'); }
  if (req.method === 'POST' && url.pathname === '/api/reset') { reset(); res.writeHead(200); return res.end('ok'); }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(DASHBOARD);
  }
  res.writeHead(404); res.end('not found');
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  ws.on('message', (data) => { try { onMsg(ws, JSON.parse(String(data))); } catch (e) { log(`плохое сообщение: ${e}`); } });
  ws.on('close', () => onClose(ws));
  ws.on('error', () => {});
});

server.listen(PORT, HOST, () => log(`хаб слушает ws://${HOST}:${PORT}, дашборд http://${HOST}:${PORT}`));

const DASHBOARD = /* html */ `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Apple Drop — хаб</title>
<style>
:root { --bg:#fff; --fg:#1d1d1f; --muted:#6e6e73; --line:#d2d2d7; --card:#f5f5f7; --ok:#248a3d; --warn:#b25000; --err:#d70015; --accent:#0071e3; }
@media (prefers-color-scheme: dark) { :root { --bg:#1d1d1f; --fg:#f5f5f7; --muted:#a1a1a6; --line:#424245; --card:#2c2c2e; --ok:#30d158; --warn:#ffd60a; --err:#ff453a; --accent:#2997ff; } }
body { margin:0; padding:16px; background:var(--bg); color:var(--fg); font:13px/1.4 -apple-system, BlinkMacSystemFont, "SF Pro Text", Helvetica, Arial, sans-serif; }
h1 { font-size:18px; margin:0 0 4px; } h2 { font-size:13px; color:var(--muted); text-transform:uppercase; margin:18px 0 6px; }
.row { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
.card { background:var(--card); border-radius:10px; padding:10px 12px; }
table { border-collapse:collapse; width:100%; font-size:12px; } th, td { text-align:left; padding:4px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--muted); }
.ok { color:var(--ok); } .warn { color:var(--warn); } .err { color:var(--err); } .muted { color:var(--muted); }
button { font:inherit; padding:6px 12px; border-radius:8px; border:1px solid var(--accent); background:var(--accent); color:#fff; cursor:pointer; font-weight:600; }
pre { font:11px/1.35 ui-monospace, Menlo, monospace; background:var(--card); padding:8px; border-radius:8px; max-height:340px; overflow:auto; white-space:pre-wrap; }
.orders { display:grid; grid-template-columns:repeat(auto-fill, minmax(230px, 1fr)); gap:8px; }
.big { font-size:16px; font-weight:600; }
</style></head><body>
<div class="row" style="justify-content:space-between"><div><h1>Apple Drop — хаб</h1><div id="head" class="muted">…</div></div>
<button id="next">Следующий на оплату</button></div>
<h2>Заказы</h2><div id="orders" class="orders"></div>
<h2>Очередь оплаты</h2><div id="queue" class="card">—</div>
<h2>Заказ × профиль × вкладка</h2>
<table><thead><tr><th>заказ</th><th>профиль</th><th>вкладка</th><th>роль</th><th>состояние</th><th>деталь</th><th>исход</th><th>обновлено (от OPEN)</th></tr></thead><tbody id="rows"></tbody></table>
<h2>Лог</h2><pre id="log"></pre>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
const rel = (t, o) => !t ? '' : o ? ((t - o) / 1000).toFixed(1) + ' с' : new Date(t).toLocaleTimeString();
let lastLog = '';
async function tick() {
  let s; try { s = await (await fetch('/api/state', { cache: 'no-store' })).json(); } catch { $('head').textContent = 'хаб недоступен'; return; }
  $('head').innerHTML = (s.openedAt ? '<span class="ok">OPEN ' + ((s.now - s.openedAt) / 1000).toFixed(1) + ' с назад</span> (' + esc(s.openSource) + ')' : 'ждём OPEN')
    + ' · наблюдатель: <b>' + esc(s.watcher ?? '—') + '</b> · профилей онлайн: ' + s.profiles.filter((p) => p.online).length + '/' + s.profiles.length;
  $('orders').innerHTML = s.orders.length ? s.orders.map((o) => '<div class="card"><div class="big">Заказ ' + esc(o.id) + '</div>'
    + '<div>победитель: <b>' + esc(o.winner ?? '—') + '</b></div>'
    + '<div>стадия: <span class="' + (o.stage === 'ORDERED' ? 'ok' : o.stage ? 'warn' : '') + '">' + esc(o.stage ?? '—') + '</span></div>'
    + (o.billingAt && s.openedAt ? '<div>Billing: +' + ((o.billingAt - s.openedAt) / 1000).toFixed(1) + ' с</div>' : '')
    + (o.standby.length ? '<div class="muted">запас: ' + esc(o.standby.join(', ')) + '</div>' : '')
    + (o.failed.length ? '<div class="err">упали: ' + esc(o.failed.join(', ')) + '</div>' : '')
    + (o.orderNo ? '<div class="ok big">' + esc(o.orderNo) + '</div>' : '') + '</div>').join('') : '<div class="muted">пока нет</div>';
  $('queue').innerHTML = (s.active ? 'сейчас: <b>' + esc(s.active.orderId) + '</b> (' + esc(s.active.profile) + ') · ' + esc(s.active.store) + ' · ' + esc(s.active.slotLabel) : 'никого')
    + (s.queue.length ? ' · ждут: ' + s.queue.map((q) => esc(q.orderId + '/' + q.profile)).join(', ') : '');
  const rows = [];
  for (const p of [...s.profiles].sort((a, b) => String(a.orderId).localeCompare(String(b.orderId)) || a.name.localeCompare(b.name))) {
    const o = s.orders.find((x) => x.id === p.orderId);
    const tag = o?.winner === p.name ? ' ★' : o?.standby.includes(p.name) ? ' (запас)' : '';
    const tabs = p.tabs.length ? p.tabs : [{}];
    for (const t of tabs) {
      const cls = /STUCK|TIMEOUT|ERROR/.test(t.state) ? 'err' : /ASSIST|STANDBY|BUSY|COUNTRY|CLOSED|QUEUE|NEED_HUMAN/.test(t.state) ? 'warn' : /BILLING|PAY|ORDERED|IN_BAG|REVIEW/.test(t.state) ? 'ok' : '';
      rows.push('<tr><td>' + esc(p.orderId) + '</td><td>' + (p.online ? '● ' : '<span class="err">○</span> ') + esc(p.name) + tag + '</td><td>' + esc(t.tabId ?? '') + '</td><td>' + esc(t.role ?? '') + '</td><td class="' + cls + '">' + esc(t.state ?? '') + '</td><td>' + esc(t.detail ?? '') + '</td><td>' + esc(t.outcome ?? '') + (t.atb404 ? ' · 404×' + t.atb404 : '') + '</td><td>' + rel(t.updatedAt, s.openedAt) + '</td></tr>');
    }
  }
  $('rows').innerHTML = rows.join('') || '<tr><td colspan="8" class="muted">нет профилей</td></tr>';
  const lg = s.log.join('\\n');
  if (lg !== lastLog) { const el = $('log'); const bottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20; el.textContent = lg; lastLog = lg; if (bottom) el.scrollTop = el.scrollHeight; }
}
$('next').onclick = () => fetch('/api/next', { method: 'POST' });
tick(); setInterval(tick, 1000);
</script></body></html>`;
