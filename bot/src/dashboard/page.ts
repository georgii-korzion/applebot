// Дашборд http://127.0.0.1:8765/?token=… (BOT-SPEC §11): обновление по WebSocket, кнопки управления.
export function dashboardHtml(): string {
  return /* html */ `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Apple Drop Bot</title><link rel="icon" href="data:,">
<style>
:root { --bg:#fff; --fg:#1d1d1f; --muted:#6e6e73; --line:#d2d2d7; --card:#f5f5f7; --ok:#248a3d; --warn:#b25000; --err:#d70015; --accent:#0071e3; }
@media (prefers-color-scheme: dark) { :root { --bg:#1d1d1f; --fg:#f5f5f7; --muted:#a1a1a6; --line:#424245; --card:#2c2c2e; --ok:#30d158; --warn:#ffd60a; --err:#ff453a; --accent:#2997ff; } }
* { box-sizing: border-box; }
body { margin:0; padding:16px; background:var(--bg); color:var(--fg); font:13px/1.4 -apple-system, BlinkMacSystemFont, "SF Pro Text", Helvetica, Arial, sans-serif; }
h1 { font-size:18px; margin:0; } h2 { font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; margin:18px 0 6px; }
.row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
.kpis { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:8px; margin-top:10px; }
.kpi { background:var(--card); border-radius:10px; padding:8px 12px; } .kpi b { display:block; font-size:20px; }
.wrap { overflow-x:auto; }
table { border-collapse:collapse; width:100%; font-size:12px; } th, td { text-align:left; padding:4px 6px; border-bottom:1px solid var(--line); vertical-align:top; white-space:nowrap; }
td.d { white-space:normal; max-width:260px; } td.acts { white-space:normal; min-width:210px; } td.acts button { margin:1px 0; } th { color:var(--muted); font-weight:500; }
.ok { color:var(--ok); } .warn { color:var(--warn); } .err { color:var(--err); } .muted { color:var(--muted); }
button { font:inherit; font-size:11px; padding:3px 8px; border-radius:6px; border:1px solid var(--line); background:var(--card); color:var(--fg); cursor:pointer; }
button.p { background:var(--accent); border-color:var(--accent); color:#fff; font-weight:600; font-size:13px; padding:6px 12px; }
button.danger { background:var(--err); border-color:var(--err); color:#fff; font-weight:600; font-size:13px; padding:6px 12px; }
pre { font:11px/1.35 ui-monospace, Menlo, monospace; background:var(--card); padding:8px; border-radius:8px; max-height:320px; overflow:auto; white-space:pre-wrap; }
.attn { background:var(--card); border-radius:10px; padding:10px 12px; }
.attn .big { font-size:16px; font-weight:600; }
</style></head><body>
<div class="row" style="justify-content:space-between">
  <div><h1>Apple Drop Bot <span id="machine" class="muted"></span></h1><div id="head" class="muted">подключение…</div></div>
  <div class="row"><button class="p" id="next">Дальше (следующее окно)</button><button class="danger" id="stopall">Стоп всех</button></div>
</div>
<div class="kpis" id="kpis"></div>
<h2>Нужен человек</h2><div class="attn" id="attn">—</div>
<h2>Браузеры</h2><div class="wrap"><table><thead><tr><th>id</th><th>стратегия</th><th>прокси · IP</th><th>состояние</th><th>с</th><th>заказ</th><th>товар</th><th>магазин · окно</th><th>оплата</th><th>ошибка</th><th></th></tr></thead><tbody id="browsers"></tbody></table></div>
<h2>Заказы <a id="csv" href="#" style="text-transform:none;font-weight:400">скачать CSV</a></h2>
<div class="wrap"><table><thead><tr><th>заказ</th><th>статус</th><th>лидер · претенденты</th><th>оплата</th><th>номер</th><th>магазин · окно</th><th>получатель</th><th>Billing</th><th>оформлен</th></tr></thead><tbody id="orders"></tbody></table></div>
<h2>Карты</h2><div class="wrap"><table><thead><tr><th>карта</th><th>роль</th><th>статус</th><th>заказы</th><th>оплачено</th><th>отказы</th><th></th></tr></thead><tbody id="cards"></tbody></table></div>
<h2>Лог</h2><pre id="log"></pre>
<script>
const token = new URLSearchParams(location.search).get('token') || '';
document.getElementById('csv').href = '/api/orders.csv?token=' + encodeURIComponent(token);
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
async function act(action, browser, arg) {
  if ((action === 'stop' || action === 'stopAll') && !confirm(browser ? 'Остановить ' + browser + '?' : 'Остановить ВСЕ браузеры?')) return;
  const r = await fetch('/api/action', { method: 'POST', headers: { 'content-type': 'application/json', 'x-token': token }, body: JSON.stringify({ action, browser, arg }) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) alert(j.error || 'ошибка');
}
window.act = act;
$('next').onclick = () => act('next');
$('stopall').onclick = () => act('stopAll');
const cls = (st) => /STUCK|TIMEOUT|ERROR|BLOCKED|DECLINED|DEAD|PROXY_DOWN/.test(st) ? 'err' : /ASSIST|NEED_HUMAN|CAPTCHA|HOLD|QUEUE|CLOSED|BUSY|SPARE|STANDBY|WAIT_|MANUAL|STOPPED/.test(st) ? 'warn' : /BILLING|PAY|ORDERED|IN_BAG|REVIEW|PLACE/.test(st) ? 'ok' : '';
let lastLog = '';
function render(s) {
  $('machine').textContent = '· ' + s.machine;
  const openAt = Date.parse(s.openAt), ref = s.openedAt || openAt, d = Math.round((s.now - ref) / 1000);
  const t = (d < 0 ? 'T-' : 'T+') + String(Math.floor(Math.abs(d) / 60)).padStart(2, '0') + ':' + String(Math.abs(d) % 60).padStart(2, '0');
  $('head').innerHTML = '<b>' + t + '</b> ' + (s.openedAt ? '<span class="ok">OPEN</span> (' + esc(s.openSource) + ')' + (s.stock && s.stock.length ? ' · сток: ' + esc(s.stock.join(', ')) : '') : s.startMode === 'stock' ? '<span class="warn">ждём сток</span> в магазинах заказов' + (s.rearms ? ' · сток кончался ' + s.rearms + ' раз' : '') : 'ждём OPEN · старт ' + esc(new Date(openAt).toLocaleString())) + (s.stopBeforePay ? ' · <span class="warn">ПРОБНЫЙ ПРОГОН (стоп на Review)</span>' : '') + ' · наблюдатели: ' + esc(s.watchers.join(', ') || '—');
  const by = {}; for (const b of s.browsers) { const k = b.status !== 'RUNNING' ? b.status : b.state; by[k] = (by[k] || 0) + 1; }
  const ord = (st) => s.orders.filter((o) => o.state === st).length;
  const kp = [
    ['браузеры', s.browsers.filter((b) => b.online).length + '/' + s.browsers.length + ' онлайн'],
    ['пущено', s.browsers.filter((b) => b.admittedSec !== null).length + ' (hold ' + s.browsers.filter((b) => b.admittedSec !== null && b.startStrategy === 'hold').length + ')'],
    ['заказы', ord('ORDERED') + ' оформлено / ' + (ord('PAY_READY') + ord('PLACED')) + ' на оплате / ' + (ord('OPEN') + ord('CLAIMED') + ord('IN_BAG')) + ' свободно'],
    ['карты', s.cards.filter((c) => c.status === 'ACTIVE').length + ' активны / ' + s.cards.filter((c) => c.status === 'EXHAUSTED').length + ' исчерпаны / ' + s.cards.filter((c) => c.status === 'BURNED').length + ' сгорели'],
    ['прокси', (() => { const px = [...new Set(s.browsers.map((b) => b.proxy).filter((p) => p && p !== 'dir'))]; return px.length ? px.length + ' (' + s.browsers.filter((b) => b.status === 'PROXY_DOWN').length + ' down)' : 'нет — все напрямую'; })()],
    ['состояния', Object.entries(by).map(([k, v]) => k + ' ' + v).join(' · ')],
  ];
  $('kpis').innerHTML = kp.map(([k, v]) => '<div class="kpi"><span class="muted">' + esc(k) + '</span><b>' + esc(v) + '</b></div>').join('');
  const a = s.attention.active;
  $('attn').innerHTML = a ? '<div class="big">👉 ' + esc(a.browser) + ' — ' + esc(a.reason) + '</div><div>' + esc(a.text) + '</div><div class="muted">в очереди ещё: ' + esc(s.attention.items.filter((x) => x !== a && !(x.browser === a.browser && x.reason === a.reason)).map((x) => x.browser + ' (' + x.reason + ')').join(', ') || '—') + '</div>' : '<span class="muted">никого</span>';
  $('browsers').innerHTML = s.browsers.map((b) => {
    const st = !b.online && b.status === 'RUNNING' ? 'нет связи' : b.noLink ? 'нет связи' : b.status !== 'RUNNING' ? b.status : b.state;
    return '<tr><td><b>' + esc(b.id) + '</b>' + (b.online ? '' : ' <span class="err">○</span>') + '</td><td>' + esc(b.strategy) + (b.strategy !== b.startStrategy ? ' <span class="muted">(был ' + esc(b.startStrategy) + ')</span>' : '') + '</td><td>' + esc(b.proxy) + (b.exitIp ? ' · ' + esc(b.exitIp) : '') + '</td>'
      + '<td class="' + cls(st) + '" title="' + esc(b.detail) + '">' + esc(st) + (b.stuck ? ' ⏳' : '') + '</td><td>' + b.stateSec + '</td><td>' + esc(b.orderId || '') + (b.role ? ' <span class="muted">' + esc(b.role) + '</span>' : '') + '</td><td>' + esc(b.part) + '</td><td>' + esc((b.store || '').replace(/^Apple /, '')) + (b.slot ? ' · ' + esc(b.slot) : '') + '</td>'
      + '<td>' + esc(b.payMethod === 'card' ? 'карта ' + b.card : b.payMethod === 'applepay' ? 'Apple Pay' : '') + '</td><td class="d ' + (st === 'ORDERED' ? 'muted' : 'err') + '" title="' + esc(b.lastError) + '">' + esc((b.lastError || '').length > 90 ? b.lastError.slice(0, 90) + '…' : b.lastError || '') + '</td>'
      + '<td class="acts"><button onclick="act(\\'show\\',\\'' + b.id + '\\')">окно</button> <button onclick="act(\\'resume\\',\\'' + b.id + '\\')">продолжить</button> <button onclick="act(\\'applepay\\',\\'' + b.id + '\\')">→ Apple Pay</button> <button onclick="const c=prompt(\\'id карты (c1, c2…)\\');if(c)act(\\'card\\',\\'' + b.id + '\\',c)">карта</button> <button onclick="act(\\'restart\\',\\'' + b.id + '\\')">перезапуск</button> <button onclick="act(\\'stop\\',\\'' + b.id + '\\')">стоп</button></td></tr>';
  }).join('') || '<tr><td colspan="11" class="muted">нет браузеров</td></tr>';
  $('orders').innerHTML = s.orders.map((o) => '<tr><td><b>' + esc(o.id) + '</b></td><td class="' + cls(o.state) + '">' + esc(o.state) + '</td><td>' + esc(o.leader || '—') + ' <span class="muted">' + esc(o.claimers.join(', ')) + '</span></td><td>' + esc(o.method === 'card' ? 'карта ' + o.card : 'Apple Pay') + (o.attempts ? ' (попытка ' + (o.attempts + 1) + ')' : '') + '</td>'
    + '<td class="ok"><b>' + esc(o.orderNo || '') + '</b></td><td>' + esc((o.store || '').replace(/^Apple /, '')) + (o.slot ? ' · ' + esc(o.slot) : '') + '</td><td class="d">' + esc(o.recipient) + '</td><td>' + (o.billingSec !== null ? '+' + o.billingSec + ' с' : '') + '</td><td>' + (o.orderedSec !== null ? '+' + o.orderedSec + ' с' : '') + '</td></tr>').join('');
  $('cards').innerHTML = s.cards.map((c) => '<tr><td>' + esc(c.id) + ' · ****' + esc(c.last4) + ' <span class="muted">' + esc(c.label) + '</span></td><td>' + esc(c.role) + '</td><td class="' + (c.status === 'BURNED' ? 'err' : c.status === 'EXHAUSTED' ? 'warn' : 'ok') + '">' + esc(c.status) + '</td><td>' + esc(c.orders.join(', ')) + '</td><td>' + c.paid + '/' + c.maxOrders + '</td><td>' + c.declines + '</td><td>' + (c.status === 'BURNED' ? '<button onclick="act(\\'unburn\\',undefined,\\'' + c.id + '\\')">вернуть</button>' : '') + '</td></tr>').join('');
  const lg = s.log.join('\\n');
  if (lg !== lastLog) { const el = $('log'); const bottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20; el.textContent = lg; lastLog = lg; if (bottom) el.scrollTop = el.scrollHeight; }
}
function connect() {
  const ws = new WebSocket('ws://' + location.host + '/dash?token=' + encodeURIComponent(token));
  ws.onmessage = (e) => { try { render(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  ws.onclose = () => { $('head').textContent = 'нет связи с оркестратором — переподключение…'; setTimeout(connect, 1500); };
}
connect();
</script></body></html>`;
}
