// Хаб v2 (FLEET-SPEC §9): раздаёт конфиг профилям из fleet.json, собирает STATUS/OPEN/PAY_READY/ORDERED/LOG,
// показывает дашборд и рассылает команды. Хаб только наблюдает: ни один шаг покупки его ответа не ждёт.
//   HUB_TOKEN=… HUB_DASH_TOKEN=… node hub/server.mjs
//   HUB_PORT (иначе PORT — его задаёт Railway, иначе 8765), слушает 0.0.0.0; FLEET_FILE=./fleet.json; RUNTIME_DIR=./runtime
// TLS — снаружи (Caddy/Nginx или домен Railway). Протокол v1 не поддерживается — расширение и хаб обновляются вместе.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { FleetSource } from './config.mjs';
import { Store } from './store.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.HUB_PORT || process.env.PORT || 8765);
const HOST = process.env.HUB_HOST ?? '0.0.0.0';
const HUB_TOKEN = process.env.HUB_TOKEN ?? '';
const DASH_TOKEN = process.env.HUB_DASH_TOKEN ?? '';
const FLEET_FILE = resolve(process.env.FLEET_FILE ?? 'fleet.json');
const RUNTIME_DIR = resolve(process.env.RUNTIME_DIR ?? 'runtime');
const LOG_KEEP = 2000;
const OFFLINE_AFTER_MS = 45_000;

// ---------- лог хаба ----------
const S = {
  startedAt: Date.now(),
  profiles: new Map(), // profileId → ProfileState
  firstOpen: null,     // { profile, at, sinceOpenAt }
  records: new Map(),  // key → OrderRecord
  log: [],             // { ts, profile, line }
  warnings: [],        // { ts, text } — дубли подключений, ошибки fleet.json
};
const ts = () => new Date().toISOString().slice(11, 23);
function hubLog(msg, level = 'info') {
  const line = `[${ts()}] [hub]${level === 'info' ? '' : ` ${level.toUpperCase()}`} ${msg}`;
  pushLog({ ts: Date.now(), profile: 'hub', line, level });
  console.log(line);
}
function pushLog(entry) {
  S.log.push(entry);
  if (S.log.length > LOG_KEEP) S.log.splice(0, S.log.length - LOG_KEEP);
  store.appendLog(entry);
}
function warn(text) {
  S.warnings.push({ ts: Date.now(), text });
  if (S.warnings.length > 20) S.warnings.splice(0, S.warnings.length - 20);
  hubLog(text, 'warn');
}

const store = new Store(RUNTIME_DIR, { log: (m, l) => hubLog(m, l) });
const fleet = new FleetSource(FLEET_FILE, { log: (m, l) => { if (l === 'warn') warn(m); else hubLog(m); } });

// ---------- профили ----------
function profile(id) {
  if (!S.profiles.has(id)) {
    S.profiles.set(id, {
      name: id, server: id.includes('-') ? id.slice(0, id.indexOf('-')) : id, ws: null, online: false, lastSeen: 0, connectedAt: 0,
      extVersion: '', cfgVersion: 0, cfgPending: null, strategy: '', targets: [], egress: null, armed: false,
      stage: null, tabs: [], openedAt: null, openSource: null, payReadyAt: null, store: null, slotLabel: null, method: null, orderNo: null, orderedAt: null,
    });
  }
  return S.profiles.get(id);
}
const publicProfile = ({ ws: _ws, ...p }) => p;

function saveState() {
  store.saveJson('state.json', () => ({
    savedAt: Date.now(), firstOpen: S.firstOpen,
    profiles: [...S.profiles.values()].map((p) => ({ ...publicProfile(p), online: false })),
  }));
}
function saveRecords() { store.saveJson('records.json', () => [...S.records.values()]); }
function keepRecord(rec) { if (rec?.key) { S.records.set(rec.key, rec); saveRecords(); } }

function restore() {
  const st = store.readJson('state.json', null);
  if (st?.profiles) {
    for (const p of st.profiles) if (p?.name) Object.assign(profile(p.name), p, { ws: null, online: false });
    S.firstOpen = st.firstOpen ?? null;
    hubLog(`состояние восстановлено: профилей ${st.profiles.length}`);
  }
  for (const r of store.readJson('records.json', [])) if (r?.key) S.records.set(r.key, r);
}

// ---------- WS ----------
function send(ws, m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }
function sendTo(id, m) { send(S.profiles.get(id)?.ws, m); }
function broadcast(m, except) { for (const p of S.profiles.values()) if (p.name !== except) send(p.ws, m); }

const openAtMs = () => Date.parse(fleet.fleet?.openAt ?? '');

function onMsg(ws, m) {
  if (!m || typeof m.t !== 'string') return;
  if (m.t === 'REGISTER') {
    const id = String(m.profile ?? '').trim();
    if (!id) { hubLog('REGISTER без profile — соединение закрыто', 'warn'); ws.close(); return; }
    const p = profile(id);
    if (p.ws && p.ws !== ws && p.ws.readyState === 1) {
      warn(`${id} подключился дважды (клон запущен два раза?) — старое соединение закрыто`);
      p.ws.dup = true;
      try { p.ws.close(); } catch { /* */ }
    }
    ws.profile = id;
    Object.assign(p, {
      ws, online: true, lastSeen: Date.now(), connectedAt: Date.now(), server: m.server || p.server, extVersion: m.extVersion ?? '',
      cfgVersion: m.cfgVersion ?? 0, strategy: m.strategy ?? '', targets: m.targets ?? [], egress: m.egress ?? p.egress,
    });
    const known = !!fleet.fleet?.profiles?.[id];
    hubLog(`REGISTER ${id} (${p.server}) · ext ${p.extVersion} · cfg v${p.cfgVersion} · ${p.strategy}${known ? '' : ' · НЕТ в fleet.json'}`, known ? 'info' : 'warn');
    send(ws, { t: 'WELCOME', serverTime: Date.now(), cfgVersion: known ? fleet.version : null });
    if (S.firstOpen && S.firstOpen.profile !== id) send(ws, { t: 'OPEN_SEEN', ...S.firstOpen });
    saveState();
    return;
  }
  const id = ws.profile;
  if (!id) return; // до REGISTER ничего не принимаем
  const p = profile(id);
  p.lastSeen = Date.now();
  switch (m.t) {
    case 'STATUS':
      Object.assign(p, {
        stage: m.stage ?? null, tabs: Array.isArray(m.tabs) ? m.tabs : [], openedAt: m.openedAt ?? p.openedAt, cfgVersion: m.cfgVersion ?? p.cfgVersion,
        cfgPending: m.cfgPending ?? null, strategy: m.strategy ?? p.strategy, egress: m.egress ?? p.egress, armed: !!m.armed,
      });
      saveState();
      break;
    case 'OPEN': {
      const at = Number(m.at) || Date.now();
      const known = p.openedAt === at; // повтор после переподключения — уже знаем
      p.openedAt = at;
      p.openSource = m.source ?? null;
      const oa = openAtMs();
      const sinceOpenAt = Number.isFinite(oa) ? at - oa : undefined;
      if (!known) hubLog(`OPEN ${id} (${m.source})${sinceOpenAt !== undefined ? ` ${(sinceOpenAt / 1000).toFixed(1)} с от openAt` : ''} · buyable ${(m.buyable ?? []).join(',') || '—'}${m.replay ? ' · повтор после переподключения' : ''}`);
      if (!S.firstOpen) {
        S.firstOpen = { profile: id, at, sinceOpenAt };
        // только информация для остальных: плашка и строка в логе, никаких действий (FLEET-SPEC §4.3)
        broadcast({ t: 'OPEN_SEEN', ...S.firstOpen }, id);
      }
      saveState();
      break;
    }
    case 'PAY_READY': {
      const known = p.payReadyAt === (Number(m.readyAt) || 0);
      Object.assign(p, { payReadyAt: Number(m.readyAt) || Date.now(), store: m.store ?? null, slotLabel: m.slotLabel ?? null, method: m.method ?? null });
      if (!known) hubLog(`PAY_READY ${id} · ${m.store} · ${m.slotLabel} · ${m.method}${p.openedAt ? ` · +${((p.payReadyAt - p.openedAt) / 1000).toFixed(1)} с от своего OPEN` : ''}${m.replay ? ' · повтор после переподключения' : ''}`);
      keepRecord(m.record);
      saveState();
      break;
    }
    case 'ORDERED':
      if (p.orderNo === m.orderNo) break; // повтор
      p.orderNo = m.orderNo ?? null;
      p.orderedAt = m.record?.orderedAt ?? Date.now();
      hubLog(`ORDERED ${id} · ${m.orderNo}${m.replay ? ' · повтор после переподключения' : ''}`);
      keepRecord(m.record);
      saveState();
      break;
    case 'LOG':
      pushLog({ ts: Date.now(), profile: id, line: String(m.line ?? '') });
      break;
    case 'PING':
      send(ws, { t: 'PONG' });
      break;
    default:
      break;
  }
}

function onClose(ws) {
  const id = ws.profile;
  if (!id) return;
  const p = S.profiles.get(id);
  if (!p || p.ws !== ws) return;
  p.ws = null;
  p.online = false;
  if (!ws.dup) hubLog(`${id} отключился`);
  saveState();
}

// ---------- команды ----------
const CMDS = new Set(['start', 'stop', 'prepare', 'cleanBag', 'reloadConfig', 'setStrategy', 'focus', 'checkIp']);

/** target: 'all' | '<profileId>' | '<server>-*' | 'server:<name>' */
function targets(target) {
  const all = [...S.profiles.values()];
  if (!target || target === 'all') return all;
  if (target.startsWith('server:')) { const s = target.slice(7); return all.filter((p) => p.server === s); }
  if (target.endsWith('-*')) { const s = target.slice(0, -2); return all.filter((p) => p.server === s); }
  return all.filter((p) => p.name === target);
}

function command(target, cmd, args = {}) {
  if (!CMDS.has(cmd)) return { ok: false, error: `неизвестная команда ${cmd}` };
  if (cmd === 'setStrategy' && !['refresh', 'hold'].includes(args?.strategy)) return { ok: false, error: 'setStrategy: strategy = refresh | hold' };
  const list = targets(target);
  const sent = [];
  const offline = [];
  for (const p of list) (p.online && p.ws ? sent : offline).push(p.name);
  for (const name of sent) sendTo(name, { t: 'COMMAND', cmd, args });
  hubLog(`команда ${cmd}${cmd === 'setStrategy' ? ` ${args.strategy}` : ''} → ${target || 'all'}: отправлена ${sent.length}${offline.length ? `, офлайн ${offline.length} (${offline.join(', ')})` : ''}`);
  return { ok: true, sent, offline };
}

// ---------- API ----------
function snapshot() {
  const oa = openAtMs();
  const profiles = [...S.profiles.values()].map((p) => {
    const cfg = fleet.config(p.name);
    const errors = cfg ? cfg.validation.errors : [`профиля нет в fleet.json`];
    return {
      ...publicProfile(p),
      fleetKnown: !!cfg, cfgErrors: errors, cfgOutdated: !!cfg && !errors.length && p.cfgVersion !== fleet.version,
      proxy: cfg?.config.proxy ? `${cfg.config.proxy.scheme}://${cfg.config.proxy.host}:${cfg.config.proxy.port}` : null,
      payment: cfg?.config.orders[0]?.payment ?? null,
    };
  });
  // профили из fleet.json, которые ещё ни разу не подключались — тоже строкой (серой)
  for (const id of fleet.ids()) {
    if (S.profiles.has(id)) continue;
    const cfg = fleet.config(id);
    profiles.push({
      name: id, server: id.includes('-') ? id.slice(0, id.indexOf('-')) : id, online: false, neverSeen: true, tabs: [], egress: null,
      fleetKnown: true, cfgErrors: cfg.validation.errors, cfgOutdated: false, strategy: cfg.config.strategy,
      proxy: cfg.config.proxy ? `${cfg.config.proxy.scheme}://${cfg.config.proxy.host}:${cfg.config.proxy.port}` : null, payment: cfg.config.orders[0]?.payment ?? null,
    });
  }
  profiles.sort((a, b) => a.server.localeCompare(b.server) || a.name.localeCompare(b.name));
  return {
    now: Date.now(), startedAt: S.startedAt,
    fleet: { file: FLEET_FILE, version: fleet.version, hash: fleet.hash, loadedAt: fleet.loadedAt, error: fleet.error, openAt: fleet.fleet?.openAt ?? null, openAtMs: Number.isFinite(oa) ? oa : null, profiles: fleet.ids().length },
    auth: { ws: !!HUB_TOKEN, dash: !!DASH_TOKEN },
    firstOpen: S.firstOpen,
    profiles,
    records: [...S.records.values()].map((r) => ({ ...r, server: S.profiles.get(r.profileId)?.server ?? '', strategy: S.profiles.get(r.profileId)?.strategy ?? '', egress: S.profiles.get(r.profileId)?.egress ?? null })),
    warnings: S.warnings,
    log: S.log.slice(-500),
  };
}

function recordsCsv() {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const fmt = (t) => (t ? new Date(t).toLocaleString('ru-RU') : '');
  const head = ['сервер', 'профиль', 'стратегия', 'IP', 'заказ', 'статус', 'номер заказа', 'товар', 'парт', 'магазин', 'окно самовывоза', 'имя', 'фамилия', 'email', 'телефон', 'оплата', 'сумма', 'OPEN', 'на оплате с', 'оформлен'];
  const rows = [...S.records.values()].map((r) => {
    const p = S.profiles.get(r.profileId);
    return [p?.server ?? '', r.profileId, p?.strategy ?? '', p?.egress?.ip ?? '', r.orderId, r.status, r.orderNo, r.partLabel, r.part, r.storeName, r.slotLabel, r.firstName, r.lastName, r.email, r.phone, r.payment, r.price, fmt(r.openedAt), fmt(r.billingAt), fmt(r.orderedAt)].map(esc).join(';');
  });
  return `﻿${[head.map(esc).join(';'), ...rows].join('\n')}`;
}

function reset() {
  for (const p of S.profiles.values()) Object.assign(p, { stage: null, tabs: [], openedAt: null, openSource: null, payReadyAt: null, store: null, slotLabel: null, method: null, orderNo: null, orderedAt: null, armed: false });
  S.firstOpen = null;
  S.log = [];
  S.warnings = [];
  hubLog('состояние профилей и лог сброшены (fleet.json и записи заказов не тронуты)');
  saveState();
}

const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => r(b)); });
function json(res, obj, status = 200, extra = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*', ...extra });
  res.end(JSON.stringify(obj));
}
function tokenOf(req, url) { return url.searchParams.get('token') ?? req.headers['x-token'] ?? ''; }
const dashOk = (req, url) => !DASH_TOKEN || tokenOf(req, url) === DASH_TOKEN;
const wsTokenOk = (req, url) => !HUB_TOKEN || tokenOf(req, url) === HUB_TOKEN;

let dashboardHtml = '';
try { dashboardHtml = readFileSync(join(here, 'dashboard.html'), 'utf8'); } catch (e) { hubLog(`dashboard.html не прочитан: ${e.message}`, 'warn'); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'hub'}`);
  const path = url.pathname;
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, x-token', 'access-control-allow-methods': 'GET, POST, OPTIONS' }); return res.end(); }
    // конфиг профиля — токен расширений (HUB_TOKEN)
    const cm = /^\/config\/([^/]+)$/.exec(path);
    if (cm && req.method === 'GET') {
      if (!wsTokenOk(req, url)) return json(res, { error: 'bad token' }, 401);
      const id = decodeURIComponent(cm[1]);
      const built = fleet.config(id);
      if (!built) return json(res, { error: `профиль ${id} не описан в fleet.json` }, 404);
      if (built.validation.errors.length) return json(res, { errors: built.validation.errors, version: fleet.version }, 422);
      return json(res, built.config, 200, { 'x-cfg-version': String(fleet.version) });
    }
    if (path === '/healthz') return json(res, { ok: true, profiles: S.profiles.size, fleetVersion: fleet.version });
    if (path === '/' || path === '/index.html') {
      if (!dashOk(req, url)) { res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('нужен ?token=<HUB_DASH_TOKEN>'); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(dashboardHtml);
    }
    if (path.startsWith('/api/')) {
      if (!dashOk(req, url)) return json(res, { error: 'bad token' }, 401);
      if (path === '/api/state' && req.method === 'GET') return json(res, snapshot());
      if (path === '/api/orders.csv' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="apple-drop-orders.csv"' });
        return res.end(recordsCsv());
      }
      if (path === '/api/command' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}');
        return json(res, command(b.target, b.cmd, b.args ?? {}));
      }
      if (path === '/api/reload' && req.method === 'POST') {
        const before = fleet.version;
        const r = fleet.load('api/reload');
        if (r.ok && fleet.version !== before) hubLog(`рассылаю CONFIG_AVAILABLE v${fleet.version}`);
        // «Разослать конфиг»: даже если файл не менялся, напомнить профилям текущую версию (отставшие подтянут)
        broadcast({ t: 'CONFIG_AVAILABLE', version: fleet.version });
        return json(res, { ok: r.ok, error: r.error, version: fleet.version, changed: fleet.version !== before });
      }
      if (path === '/api/reset' && req.method === 'POST') { reset(); return json(res, { ok: true }); }
      return json(res, { error: 'not found' }, 404);
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    hubLog(`HTTP ${req.method} ${path}: ${e.message}`, 'warn');
    if (!res.headersSent) json(res, { error: String(e.message ?? e) }, 500);
  }
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'hub'}`);
  const origin = req.headers.origin;
  if (url.pathname !== '/ws' && url.pathname !== '/') { socket.destroy(); return; }
  if (!wsTokenOk(req, url)) { hubLog(`WS без верного токена с ${req.socket.remoteAddress} — закрыто`, 'warn'); socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  if (origin && !String(origin).startsWith('chrome-extension://')) { hubLog(`WS с чужим Origin ${origin} — закрыто`, 'warn'); socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
wss.on('connection', (ws) => {
  ws.on('message', (data) => { try { onMsg(ws, JSON.parse(String(data))); } catch (e) { hubLog(`плохое сообщение: ${e.message}`, 'warn'); } });
  ws.on('close', () => onClose(ws));
  ws.on('error', () => {});
});

// профиль без PING/STATUS дольше 45 с — считаем офлайн (сокет мог умереть молча)
setInterval(() => {
  const now = Date.now();
  for (const p of S.profiles.values()) {
    if (p.online && now - p.lastSeen > OFFLINE_AFTER_MS) { p.online = false; hubLog(`${p.name}: нет сообщений ${Math.round((now - p.lastSeen) / 1000)} с — офлайн`, 'warn'); try { p.ws?.terminate(); } catch { /* */ } p.ws = null; saveState(); }
  }
}, 10_000);

// ---------- старт ----------
restore();
fleet.load('start');
fleet.onChange((f) => broadcast({ t: 'CONFIG_AVAILABLE', version: f.version }));
fleet.watch();
if (!HUB_TOKEN) warn('HUB_TOKEN не задан — WS и /config без авторизации (только для локальных тестов)');
if (process.env.HUB_ALLOW_MOCK) warn('HUB_ALLOW_MOCK задан — baseUrl мока разрешён (только для e2e-тестов)');
if (!DASH_TOKEN) warn('HUB_DASH_TOKEN не задан — дашборд и API без авторизации (только для локальных тестов)');
server.listen(PORT, HOST, () => hubLog(`хаб слушает ${HOST}:${PORT} · ws://…/ws?token=… · дашборд http://…/?token=… · fleet ${FLEET_FILE} · runtime ${RUNTIME_DIR}`));

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { store.close(); process.exit(0); });
