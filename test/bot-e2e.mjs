// E2E бота (docs/BOT-SPEC.md §15) на мок-сервере: настоящий оркестратор (bot/dist/bot.mjs) запускает Chromium
// с dev-сборкой расширения; «человек» действует через CDP (Playwright connectOverCDP); Telegram и вебхуки — тестовые.
//   npm run test:bot                     — все сценарии
//   node test/bot-e2e.mjs bot-single notify
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import net from 'node:net';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MOCK = 'http://127.0.0.1:4777';
const HUB_PORT = 18790;
const TG_PORT = 18799;
const HOOK_PORT = 18798;
const ART = join(root, 'test/.artifacts');
const HEADLESS = process.env.HEADED !== '1';
const BOT = join(root, 'bot/dist/bot.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const say = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...a);

// ---------- процессы ----------
const children = [];
function run(file, args, env, label) {
  const ch = spawn(process.execPath, [join(root, file), ...args], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  ch.stdout.on('data', (d) => logs.push(String(d)));
  ch.stderr.on('data', (d) => logs.push(String(d)));
  ch.logs = logs;
  ch.label = label ?? file.split('/').pop();
  children.push(ch);
  return ch;
}
async function waitHttp(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch { /* */ }
    await sleep(150);
  }
  throw new Error(`не поднялся ${url}`);
}
async function stopChild(ch, sig = 'SIGTERM') {
  if (ch.exitCode !== null || ch.signalCode) return;
  ch.kill(sig);
  await Promise.race([new Promise((r) => ch.once('exit', r)), sleep(5000)]);
}

async function startMock(env = {}) {
  const ch = run('test/mock-server.mjs', [], { OPEN_AFTER: '3600', BUSY_FIRST: '0', ...env }, 'mock');
  await waitHttp(`${MOCK}/__state`);
  return ch;
}
const mockState = async () => (await fetch(`${MOCK}/__state`)).json();
const mockConfig = async (cfg) => (await fetch(`${MOCK}/__config`, { method: 'POST', body: JSON.stringify(cfg) })).json();

// ---------- Telegram и вебхуки (тестовые приёмники) ----------
const tg = { calls: [], updates: [], server: null, msgId: 100 };
function startTelegram() {
  tg.calls = []; tg.updates = []; tg.msgId = 100;
  tg.server = http.createServer(async (req, res) => {
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '');
    let body = '';
    for await (const c of req) body += c;
    let params = {};
    try { params = JSON.parse(body); } catch { params = { raw: body.slice(0, 2000) }; }
    const method = m?.[2] ?? '?';
    tg.calls.push({ method, params, at: Date.now() });
    res.writeHead(200, { 'content-type': 'application/json' });
    if (method === 'getUpdates') {
      for (let i = 0; i < 10 && !tg.updates.length; i++) await sleep(100);
      const ups = tg.updates.splice(0);
      return res.end(JSON.stringify({ ok: true, result: ups }));
    }
    if (method === 'getMe') return res.end(JSON.stringify({ ok: true, result: { id: 1, username: 'test_bot' } }));
    if (method === 'sendMessage' || method === 'sendPhoto') return res.end(JSON.stringify({ ok: true, result: { message_id: ++tg.msgId } }));
    res.end(JSON.stringify({ ok: true, result: true }));
  });
  return new Promise((r) => tg.server.listen(TG_PORT, '127.0.0.1', r));
}
const hooks = { got: [], server: null };
const HOOK_SECRET = 'whsec-test-123';
function startHooks() {
  hooks.got = [];
  hooks.server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const sig = req.headers['x-signature'];
    const want = `sha256=${createHmac('sha256', HOOK_SECRET).update(body).digest('hex')}`;
    let j = null;
    try { j = JSON.parse(body); } catch { /* */ }
    hooks.got.push({ body, json: j, sigOk: sig === want, at: Date.now() });
    res.writeHead(200);
    res.end('ok');
  });
  return new Promise((r) => hooks.server.listen(HOOK_PORT, '127.0.0.1', r));
}

// ---------- тестовые апстрим-прокси (с логином) ----------
const upstreams = [];
function authOk(req, user, pass) {
  const h = req.headers['proxy-authorization'] ?? '';
  return h === `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}
/** HTTP-прокси с Basic-авторизацией; к обычным HTTP-запросам добавляет x-test-exit-ip (так мок «видит» выходной IP). */
function startHttpUpstream(label, port, user = 'u', pass = 'p') {
  const stats = { label, plain: 0, connect: 0, targets: {} };
  const sockets = new Set();
  const srv = http.createServer((req, res) => {
    if (!authOk(req, user, pass)) { res.writeHead(407, { 'proxy-authenticate': 'Basic realm="t"' }); return res.end(); }
    stats.plain++;
    const u = new URL(req.url);
    stats.targets[u.host] = (stats.targets[u.host] ?? 0) + 1;
    const headers = { ...req.headers, 'x-test-exit-ip': label };
    delete headers['proxy-authorization'];
    const p = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: req.method, headers }, (pr) => { res.writeHead(pr.statusCode, pr.headers); pr.pipe(res); });
    p.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(p);
  });
  srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  srv.on('connect', (req, sock, head) => {
    if (!authOk(req, user, pass)) { sock.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
    stats.connect++;
    stats.targets[req.url] = (stats.targets[req.url] ?? 0) + 1;
    const i = req.url.lastIndexOf(':');
    const up = net.connect(Number(req.url.slice(i + 1)), req.url.slice(0, i), () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head?.length) up.write(head); up.pipe(sock); sock.pipe(up); });
    sockets.add(up);
    up.on('error', () => sock.destroy());
    sock.on('error', () => up.destroy());
  });
  const h = { stats, srv, port, close: () => new Promise((r) => { for (const s of sockets) s.destroy(); srv.close(r); }) };
  upstreams.push(h);
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(h)));
}
/** SOCKS5 с логином; к цели подключается с адреса 127.0.0.2 — мок различает его как отдельный выходной IP. */
function startSocksUpstream(port, user = 'su', pass = 'sp') {
  const stats = { label: 'socks', connect: 0, targets: {} };
  const sockets = new Set();
  const srv = net.createServer((c) => {
    sockets.add(c);
    c.on('close', () => sockets.delete(c));
    c.on('error', () => {});
    let buf = Buffer.alloc(0);
    let stage = 0;
    c.on('data', function onData(d) {
      buf = Buffer.concat([buf, d]);
      if (stage === 0 && buf.length >= 2 && buf.length >= 2 + buf[1]) { buf = buf.subarray(2 + buf[1]); c.write(Buffer.from([5, 2])); stage = 1; }
      if (stage === 1 && buf.length >= 2) {
        const ul = buf[1]; if (buf.length < 3 + ul) return; const pl = buf[2 + ul]; if (buf.length < 3 + ul + pl) return;
        const u = buf.subarray(2, 2 + ul).toString(), p = buf.subarray(3 + ul, 3 + ul + pl).toString();
        buf = buf.subarray(3 + ul + pl);
        if (u !== user || p !== pass) { c.end(Buffer.from([1, 1])); return; }
        c.write(Buffer.from([1, 0])); stage = 2;
      }
      if (stage === 2 && buf.length >= 5) {
        const atyp = buf[3];
        let host, off;
        if (atyp === 3) { const n = buf[4]; if (buf.length < 5 + n + 2) return; host = buf.subarray(5, 5 + n).toString(); off = 5 + n; }
        else if (atyp === 1) { if (buf.length < 10) return; host = [...buf.subarray(4, 8)].join('.'); off = 8; }
        else { c.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
        const tport = buf.readUInt16BE(off);
        const rest = buf.subarray(off + 2);
        stage = 3;
        c.removeListener('data', onData);
        stats.connect++;
        stats.targets[`${host}:${tport}`] = (stats.targets[`${host}:${tport}`] ?? 0) + 1;
        const up = net.connect({ host: host === 'localhost' ? '127.0.0.1' : host, port: tport, localAddress: '127.0.0.2' }, () => {
          c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 2, 0, 0]));
          if (rest.length) up.write(rest);
          up.pipe(c); c.pipe(up);
        });
        sockets.add(up);
        up.on('error', () => c.destroy());
      }
    });
  });
  const h = { stats, srv, port, close: () => new Promise((r) => { for (const s of sockets) s.destroy(); srv.close(r); }) };
  upstreams.push(h);
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(h)));
}

// ---------- бот ----------
const CARD1 = { id: 'c1', label: 'Карта 1', role: 'primary', number: '4111111111111111', expiry: '12/29', cvv: '123', name: 'AHMED TEST', billing: { title: 'Mr.', firstName: '', lastName: '', street: 'Sheikh Zayed Rd 1', area: 'Downtown', town: '', city: 'Dubai' }, maxOrders: 2 };
const CARD2 = { ...CARD1, id: 'c2', label: 'Карта 2', number: '5555555555554444', cvv: '456', name: 'MARIA TEST' };
const CARD_RES = { ...CARD1, id: 'c3', label: 'Запасная', role: 'reserve', number: '4242424242424242', cvv: '789', name: 'OMAR TEST' };
const RECIPIENTS = {
  r1: { firstName: 'Ahmed', lastName: 'Test', email: 'ahmed.test@example.com', phone: '0501234567' },
  r2: { firstName: 'Maria', lastName: 'Test', email: 'maria.test@example.com', phone: '0529876543' },
  r3: { firstName: 'Omar', lastName: 'Test', email: 'omar.test@example.com', phone: '0551112233' },
  r4: { firstName: 'Lina', lastName: 'Test', email: 'lina.test@example.com', phone: '0561112233' },
};
const order = (id, i, extra = {}) => ({ id, priority: i + 1, targets: ['MK254AH/A', 'MK244AH/A'], stores: ['R597', 'R596', 'R706'], city: 'Dubai', recipient: `r${i + 1}`, payment: 'card', ...extra });

function merge(a, b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return b === undefined ? a : b;
  const out = { ...(a ?? {}) };
  for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(out[k], v) : v;
  return out;
}

function botConfig(name, openInSec, extra = {}) {
  return merge({
    machine: 'test', openAt: new Date(Date.now() + openInSec * 1000).toISOString(), baseUrl: MOCK, runtimeDir: `test/.bot/${name}/runtime`,
    hub: { port: HUB_PORT },
    fleet: { browsers: 1, launchStaggerMs: 300, strategyMix: { refresh: 1, hold: 0 }, adaptive: false, holdMaxWaitSec: 120, claimersPerOrder: 1, headless: HEADLESS, extensionDir: 'dist-dev', extraArgs: ['--no-sandbox'], cdpBasePort: 19300, warmupSec: 0, window: { width: 1280, height: 900 }, openJitter: 'none' },
    proxies: { mode: 'off', basePort: 18850, probe: '127.0.0.1:4777', downAfterSec: 6 },
    orders: [order('A', 0)],
    payment: { stopBeforePay: false, card: { threeDsTimeoutSec: 60 }, applePay: { timeoutSec: 90, reopenTries: 3 } },
    notify: { telegram: { enabled: true, apiBase: `http://127.0.0.1:${TG_PORT}`, statusEditMs: 3000 }, webhooks: { enabled: true }, file: { enabled: true } },
    timing: { closedReloadMs: 5000 },
  }, extra);
}
function botSecrets(extra = {}) {
  return merge({
    recipients: RECIPIENTS, cards: [CARD1], proxies: [],
    telegram: { botToken: 'TEST:TOKEN', chatId: '42', allowedUserIds: [7] },
    webhooks: [{ url: `http://127.0.0.1:${HOOK_PORT}/hook`, secret: HOOK_SECRET }],
  }, extra);
}

let current = null;
async function startBot(name, cfg, sec, { fresh = true } = {}) {
  const dir = join(root, 'test/.bot', name);
  if (fresh) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bot.config.json'), JSON.stringify(cfg, null, 1));
  writeFileSync(join(dir, 'secrets.local.json'), JSON.stringify(sec, null, 1));
  const args = ['start', '--config', join(dir, 'bot.config.json'), '--secrets', join(dir, 'secrets.local.json'), '--no-open'];
  if (fresh) args.push('--fresh');
  const proc = run('bot/dist/bot.mjs', args, { BOT_TEST: '1' }, `bot-${name}`);
  await waitHttp(`http://127.0.0.1:${HUB_PORT}/health`, 20000);
  const rt = join(root, cfg.runtimeDir);
  let token = '';
  for (let i = 0; i < 40 && !token; i++) { try { token = JSON.parse(readFileSync(join(rt, 'state.json'), 'utf8')).dashToken; } catch { await sleep(100); } }
  const h = {
    name, dir, rt, proc, token, cfg,
    state: async () => (await fetch(`http://127.0.0.1:${HUB_PORT}/api/state?token=${token}`)).json(),
    act: async (action, browser, arg) => (await fetch(`http://127.0.0.1:${HUB_PORT}/api/action`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-token': token }, body: JSON.stringify({ action, browser, arg }) })).json(),
    events: () => { try { return readFileSync(join(rt, 'events.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } },
    file: (f) => { try { return readFileSync(join(rt, f), 'utf8'); } catch { return ''; } },
  };
  current = h;
  return h;
}

function botPids(rt) {
  try { return Object.values(JSON.parse(readFileSync(join(rt, 'state.json'), 'utf8')).browsers).map((b) => b.pid).filter(Boolean); } catch { return []; }
}
async function stopBot(h, { kill = true } = {}) {
  if (!h) return;
  if (h.proc.exitCode === null) {
    await h.act('shutdown').catch(() => {});
    await Promise.race([new Promise((r) => h.proc.once('exit', r)), sleep(5000)]);
    await stopChild(h.proc, 'SIGKILL');
  }
  if (kill) for (const pid of botPids(h.rt)) { try { process.kill(pid, 'SIGKILL'); } catch { /* */ } }
}

async function teardown() {
  if (current) await stopBot(current);
  current = null;
  for (const ch of children.splice(0)) await stopChild(ch, 'SIGKILL');
  for (const u of upstreams.splice(0)) await u.close().catch(() => {});
  if (tg.server) await new Promise((r) => tg.server.close(r));
  if (hooks.server) await new Promise((r) => hooks.server.close(r));
  tg.server = null; hooks.server = null;
  await sleep(300);
}

async function waitFor(fn, ms, label, every = 300) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); } catch (e) { last = null; }
    if (last) return last;
    await sleep(every);
  }
  throw new Error(`таймаут: ${label}`);
}

/** Страница браузера через CDP — «человек». */
async function humanPage(h, browserId, urlPart = '/ae/') {
  const s = await h.state();
  const b = s.browsers.find((x) => x.id === browserId);
  const cdp = await chromium.connectOverCDP(`http://127.0.0.1:${b.cdpPort}`);
  const pages = cdp.contexts().flatMap((c) => c.pages());
  const page = pages.find((p) => p.url().includes(urlPart)) ?? pages[0];
  return { cdp, page };
}

async function dump(name) {
  mkdirSync(ART, { recursive: true });
  for (const ch of children) writeFileSync(join(ART, `bot-${name}-${ch.label}.log`), ch.logs.join(''));
  try { writeFileSync(join(ART, `bot-${name}-mock-state.json`), JSON.stringify(await mockState(), null, 1)); } catch { /* */ }
  if (current) {
    try { writeFileSync(join(ART, `bot-${name}-hub-state.json`), JSON.stringify(await current.state(), null, 1)); } catch { /* */ }
    const logs = join(current.rt, 'logs');
    if (existsSync(logs)) for (const f of readdirSync(logs)) if (f.endsWith('.log') && !f.includes('chrome')) writeFileSync(join(ART, `bot-${name}-${f}`), readFileSync(join(logs, f)));
    try {
      const s = await current.state();
      let i = 0;
      for (const b of s.browsers.filter((x) => x.online && x.cdpPort)) {
        const { cdp, page } = await humanPage(current, b.id).catch(() => ({}));
        if (page) await page.screenshot({ path: join(ART, `bot-${name}-${b.id}-${i++}.png`) }).catch(() => {});
        await cdp?.close().catch(() => {});
      }
    } catch { /* */ }
  }
  say(`артефакты: ${ART}`);
}

/** В файлах runtime и уведомлениях нет полных номеров карт и токенов. */
function assertNoLeaks(h, extra = []) {
  const cards = [CARD1.number, CARD2.number, CARD_RES.number, '4111 1111', '5555 5555'];
  const st = JSON.parse(h.file('state.json') || '{}');
  const tokens = [st.dashToken, ...Object.values(st.browsers ?? {}).map((b) => b.token)].filter(Boolean);
  const texts = [
    ['state.json', h.file('state.json')], ['events.ndjson', h.file('events.ndjson')], ['hub.log', h.file('hub.log')], ['notify.txt', h.file('notify.txt')], ['orders.txt', h.file('orders.txt')],
    ...readdirSync(join(h.rt, 'logs')).filter((f) => !f.includes('chrome')).map((f) => [`logs/${f}`, readFileSync(join(h.rt, 'logs', f), 'utf8')]),
    ['webhooks', hooks.got.map((x) => x.body).join('\n')], ['telegram', JSON.stringify(tg.calls.map((c) => c.params))], ...extra,
  ];
  for (const [name, t] of texts) {
    for (const c of cards) assert.ok(!t.includes(c), `${name}: полный номер карты ****${c.slice(-4)}`);
    if (name !== 'state.json') for (const tok of tokens) assert.ok(!t.includes(tok), `${name}: токен`);
    assert.ok(!/atbtoken=[0-9a-f]{5,}/i.test(t), `${name}: atbtoken`);
  }
}

// ---------- сценарии ----------
const scenarios = {};

/** 1 браузер, 1 заказ, карта: до W…, один клик Place Order, вебхук с полными контактами, карта только ****1111. */
scenarios['bot-single'] = async () => {
  await startMock({ OPEN_AFTER: '6', THREEDS_MS: '2000' });
  await startTelegram(); await startHooks();
  const h = await startBot('single', botConfig('single', 6), botSecrets());
  const s = await waitFor(async () => { const x = await h.state(); return x.orders[0].state === 'ORDERED' ? x : null; }, 90000, 'ORDERED', 500);
  const ms = await mockState();
  say(`bot-single: ${s.orders[0].orderNo} за ${s.orders[0].orderedSec} с от OPEN · Billing +${s.orders[0].billingSec} с`);
  assert.equal(ms.orders.length, 1, 'ровно один заказ');
  assert.equal(ms.orders[0].orderNo, s.orders[0].orderNo);
  assert.equal(ms.placeLog.length, 1, 'один клик Place Order');
  assert.equal(ms.orders[0].checkout.placeOrderClicks, 1);
  assert.equal(ms.orders[0].cardLast4, '1111');
  const ev = h.events().map((e) => e.type);
  for (const t of ['run.started', 'store.opened', 'browser.admitted', 'order.in_bag', 'pay.3ds', 'order.placed']) assert.ok(ev.includes(t), `событие ${t}`);
  const placed = await waitFor(() => hooks.got.find((x) => x.json?.event === 'order.placed'), 10000, 'вебхук order.placed');
  assert.ok(placed.sigOk, 'подпись HMAC');
  assert.deepEqual(placed.json.recipient, RECIPIENTS.r1, 'полные контакты получателя');
  assert.equal(placed.json.payment.cardLast4, '1111');
  assert.equal(placed.json.order.number, s.orders[0].orderNo);
  assert.ok(placed.json.timings.openToOrderSec > 0);
  assert.ok(tg.calls.some((c) => c.method === 'sendMessage' && /✅ Заказ W/.test(c.params.text)), 'Telegram: заказ');
  assert.ok(h.file('orders.txt').includes(s.orders[0].orderNo) && h.file('orders.txt').includes('0501234567'), 'orders.txt с полными данными');
  assert.ok(h.file('logs/b01.log').includes('****1111'), 'в логе карта как ****1111');
  assertNoLeaks(h);
};

/** 6 браузеров, 3 заказа: позднее назначение, без дублей, запасные вернулись в пул. */
scenarios['bot-pool'] = async () => {
  await startMock({ OPEN_AFTER: '15', THREEDS_MS: '800' });
  await startTelegram(); await startHooks();
  const cfg = botConfig('pool', 15, { fleet: { browsers: 6, claimersPerOrder: 2 }, orders: [order('A', 0), order('B', 1), order('C', 2)] });
  const h = await startBot('pool', cfg, botSecrets({ cards: [CARD1, CARD2] }));
  const s = await waitFor(async () => { const x = await h.state(); return x.orders.every((o) => o.state === 'ORDERED') ? x : null; }, 150000, '3 заказа ORDERED', 1000);
  await sleep(8000); // запасные дочищают корзины
  const ms = await mockState();
  const ev = h.events();
  say(`bot-pool: ${s.orders.map((o) => `${o.id} ${o.orderNo} (${o.leader}, +${o.orderedSec} с)`).join(' · ')} · RELEASED ${ev.filter((e) => e.type === 'released').length} · SPARE ${ev.filter((e) => e.type === 'spare').length}`);
  assert.equal(ms.orders.length, 3, 'ровно 3 заказа на моке');
  assert.equal(new Set(s.orders.map((o) => o.orderNo)).size, 3, 'номера разные');
  assert.equal(new Set(s.orders.map((o) => o.leader)).size, 3, 'три разных лидера');
  assert.equal(ms.placeLog.length, 3, 'по одному Place Order на заказ');
  const withBag = ms.sessions.filter((x) => x.bag.length);
  assert.equal(withBag.length, 0, `корзины пусты (заказы оплачены, запасные почистили): ${withBag.map((x) => x.bag.length)}`);
  assert.ok(ev.some((e) => e.type === 'assign'), 'ASSIGN после ADMITTED');
  assert.ok(ev.some((e) => e.type === 'released'), 'запасной вернулся в пул');
  assert.ok(ev.some((e) => e.type === 'spare'), 'вернувшийся в пул снова пущен и стоит запасом (SPARE)');
  const assigns = ev.filter((e) => e.type === 'assign');
  assert.ok(assigns.every((a) => ev.some((x) => x.type === 'browser.admitted' && x.browser === a.browser && x.ts <= a.ts)), 'заказ — только после ADMITTED');
  // карты по кругу: c1 и c2 обе в деле
  assert.ok(s.cards.find((c) => c.id === 'c1').paid >= 1 && s.cards.find((c) => c.id === 'c2').paid >= 1, 'primary-карты по кругу');
};

/** Гипотеза 1: мок пускает только перезагрузившихся (refresh) или сам из очереди (queue); смешанный флот, адаптация. */
function h1(mode) {
  return async () => {
    const OPEN = 25;
    await startMock({ OPEN_AFTER: String(OPEN), ADMIT_MODE: mode, ADMIT_EVERY_MS: '1500', ADMIT_MIN_WAIT_MS: '3000', THREEDS_MS: '500' });
    await startTelegram(); await startHooks();
    const cfg = botConfig(`h1-${mode}`, OPEN, {
      fleet: { browsers: 6, claimersPerOrder: 1, strategyMix: { refresh: 0.5, hold: 0.5 }, adaptive: true, adaptiveWindowsSec: [6, 5], holdMaxWaitSec: 150, launchStaggerMs: 200 },
      orders: [order('A', 0), order('B', 1), order('C', 2)],
    });
    const h = await startBot(`h1-${mode}`, cfg, botSecrets({ cards: [CARD1, CARD2] }));
    const s0 = await waitFor(async () => { const x = await h.state(); return x.browsers.filter((b) => b.online).length === 6 ? x : null; }, 30000, '6 браузеров онлайн');
    const hold = s0.browsers.filter((b) => b.strategy === 'hold').map((b) => b.id);
    say(`h1-${mode}: hold ${hold.join(',')}, refresh ${s0.browsers.filter((b) => b.strategy === 'refresh').map((b) => b.id).join(',')}`);
    assert.equal(hold.length, 3);
    const s = await waitFor(async () => { const x = await h.state(); return x.orders.every((o) => o.state === 'ORDERED') ? x : null; }, 150000, '3 заказа ORDERED', 1000);
    const ev = h.events();
    const sw = ev.filter((e) => e.type === 'strategy.switched');
    const win = mode === 'refresh' ? 'refresh' : 'hold';
    say(`h1-${mode}: заказы ${s.orders.map((o) => `${o.id}+${o.orderedSec}с`).join(' ')} · переключения: ${sw.map((e) => `${e.browsers.join(',')}→${e.to}`).join('; ')}`);
    assert.ok(sw.some((e) => e.to === win && /адаптация/.test(e.reason)), `адаптация перевела отстающих на ${win}`);
    const adm = ev.filter((e) => e.type === 'browser.admitted');
    assert.ok(adm.filter((e) => e.strategy === win).length >= 2, `пустило ≥2 браузера ${win}`);
    if (mode === 'queue') {
      const ms = await mockState();
      assert.ok(ms.sessions.filter((x) => x.admitted).length >= 3, 'очередь мока пускала сессии');
    }
    const r = spawnSyncNode(['bot/dist/bot.mjs', 'report', '--config', join(h.dir, 'bot.config.json'), '--secrets', join(h.dir, 'secrets.local.json')]);
    say(`h1-${mode}: отчёт → ${/Вывод: (.*)/.exec(r)?.[1]}`);
    assert.ok(new RegExp(`сработала стратегия ${win}`).test(r), `отчёт называет ${win}`);
  };
}
scenarios['h1-refresh'] = h1('refresh');
scenarios['h1-queue'] = h1('queue');

function spawnSyncNode(args) {
  const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', env: { ...process.env, BOT_TEST: '1' } });
  return (r.stdout ?? '') + (r.stderr ?? '');
}

/** Отказ карты: браузер ушёл на Apple Pay, у второго заказа карта заменена, по сгоревшей карте ни одного Place Order после отказа. */
function declineScenario(withReserve) {
  return async () => {
    await startMock({ OPEN_AFTER: '6', DECLINE_LAST4: '1111' });
    await startTelegram(); await startHooks();
    const name = withReserve ? 'decline' : 'pool-empty';
    const cfg = botConfig(name, 6, { fleet: { browsers: 2 }, orders: [order('A', 0), order('B', 1)] });
    const h = await startBot(name, cfg, botSecrets({ cards: withReserve ? [CARD1, CARD_RES] : [CARD1] }));
    // ждём отказ и переход на Apple Pay
    await waitFor(async () => h.events().some((e) => e.type === 'card.declined'), 90000, 'отказ карты', 500);
    const declined = h.events().find((e) => e.type === 'card.declined');
    // второй заказ: с запасной — оплачен картой 4242; без запасных — тоже Apple Pay
    const s = await waitFor(async () => {
      const x = await h.state();
      const other = x.orders.find((o) => o.id !== declined.orderId);
      return (withReserve ? other.state === 'ORDERED' : other.method === 'applepay') ? x : null;
    }, 90000, withReserve ? 'второй заказ оплачен запасной' : 'второй заказ на Apple Pay', 500);
    // браузеры на Apple Pay: QR открыт — «человек» подтверждает
    const apOrders = s.orders.filter((o) => o.method === 'applepay');
    for (const o of apOrders) {
      await waitFor(async () => (await h.state()).browsers.find((b) => b.id === o.leader)?.state === 'WAIT_APPLEPAY', 60000, `QR у ${o.leader}`, 500);
      const { cdp, page } = await humanPage(h, o.leader, '_s=Review');
      await page.click('[data-test=applepay-confirm]');
      await cdp.close();
    }
    const fin = await waitFor(async () => { const x = await h.state(); return x.orders.every((o) => o.state === 'ORDERED') ? x : null; }, 60000, 'все заказы ORDERED', 500);
    const ms = await mockState();
    const ev = h.events();
    say(`${name}: ${fin.orders.map((o) => `${o.id} ${o.method} ${o.card || ''} ${o.orderNo}`).join(' · ')} · placeLog ${ms.placeLog.map((p) => `${p.method ?? p.last4}:${p.result}`).join(',')}`);
    assert.equal(ms.placeLog.filter((p) => p.last4 === '1111').length, 1, 'по карте ****1111 ровно один Place Order (отказ)');
    assert.equal(fin.cards.find((c) => c.id === 'c1').status, 'BURNED', 'карта сгорела');
    assert.equal(fin.orders.find((o) => o.id === declined.orderId).method, 'applepay', 'отказавший браузер — на Apple Pay');
    assert.equal(ms.orders.length, 2, 'два заказа, без дублей');
    if (withReserve) {
      assert.ok(ev.some((e) => e.type === 'card.swapped'), 'событие card.swapped');
      assert.ok(ms.placeLog.some((p) => p.last4 === '4242' && p.result === 'ok'), 'второй заказ оплачен запасной картой');
    } else {
      assert.ok(ev.some((e) => e.type === 'cards.exhausted'), 'событие cards.exhausted');
      assert.equal(ms.placeLog.filter((p) => p.last4 && p.result === 'ok').length, 0, 'картой больше никто не платил');
    }
    assert.ok(hooks.got.some((x) => x.json?.event === 'card.declined' && x.json.cardLast4 === '1111'), 'вебхук card.declined с ****1111');
    assertNoLeaks(h);
  };
}
scenarios['card-decline'] = declineScenario(true);
scenarios['card-pool-empty'] = declineScenario(false);

/** Общая ошибка после Place Order → NEED_HUMAN, ноль повторных кликов, карта не сгорела. */
scenarios['place-generic-error'] = async () => {
  await startMock({ OPEN_AFTER: '5', PLACE_GENERIC_ERR: '1' });
  await startTelegram(); await startHooks();
  const h = await startBot('generic', botConfig('generic', 5), botSecrets());
  const s = await waitFor(async () => { const x = await h.state(); return x.attention.active?.reason === 'payment' ? x : null; }, 90000, 'человек: оплата', 500);
  await sleep(4000);
  const ms = await mockState();
  const fin = await h.state();
  say(`place-generic-error: ${fin.browsers[0].state} — ${fin.browsers[0].detail} · кликов Place Order ${ms.placeLog.length}`);
  assert.equal(ms.placeLog.length, 1, 'ноль повторных кликов');
  assert.equal(ms.orders.length, 0);
  assert.equal(fin.browsers[0].state, 'NEED_HUMAN');
  assert.equal(fin.cards[0].status, 'ACTIVE', 'карта не сгорела');
  assert.equal(fin.orders[0].state, 'NEED_HUMAN');
  assert.ok(tg.calls.some((c) => c.method === 'sendMessage' && /Нужен человек/.test(c.params.text) && c.params.reply_markup), 'Telegram: человек с кнопками');
  assert.ok(s.attention.active.browser === 'b01');
};

/** Apple Pay: только настоящий клик (CDP), QR истекает и открывается снова, очередь — одно окно за раз. */
scenarios['applepay-qr'] = async () => {
  await startMock({ OPEN_AFTER: '6', APPLEPAY_TRUSTED_ONLY: '1', APPLEPAY_QR_EXPIRE_MS: '5000' });
  await startTelegram(); await startHooks();
  const cfg = botConfig('applepay', 6, { fleet: { browsers: 2 }, orders: [order('A', 0, { payment: 'applepay' }), order('B', 1, { payment: 'applepay' })] });
  const h = await startBot('applepay', cfg, botSecrets({ cards: [] }));
  let both = 0;
  const watch = setInterval(async () => { try { const x = await h.state(); if (x.browsers.filter((b) => b.state === 'WAIT_APPLEPAY').length > 1) both++; } catch { /* */ } }, 400);
  try {
    const first = await waitFor(async () => (await h.state()).browsers.find((b) => b.state === 'WAIT_APPLEPAY'), 90000, 'первый QR', 400);
    say(`applepay-qr: QR у ${first.id}, ждём истечения и повторного открытия`);
    await waitFor(async () => { const m = await mockState(); return m.sessions.some((x) => (x.checkout.applePayExpired ?? 0) >= 1 && (x.checkout.applePaySheets ?? 0) >= 2); }, 30000, 'QR истёк и открыт снова', 500);
    const other = (await h.state()).browsers.find((b) => b.id !== first.id);
    assert.notEqual(other.state, 'WAIT_APPLEPAY', 'второй QR не показан, пока первый на экране');
    let { cdp, page } = await humanPage(h, first.id, '_s=Review');
    await page.waitForSelector('#applepay-sheet:not([hidden])', { timeout: 15000 });
    await page.click('[data-test=applepay-confirm]');
    await cdp.close();
    const second = await waitFor(async () => (await h.state()).browsers.find((b) => b.id !== first.id && b.state === 'WAIT_APPLEPAY'), 60000, 'QR у второго после первого', 400);
    ({ cdp, page } = await humanPage(h, second.id, '_s=Review'));
    await page.click('[data-test=applepay-confirm]');
    await cdp.close();
    const fin = await waitFor(async () => { const x = await h.state(); return x.orders.every((o) => o.state === 'ORDERED') ? x : null; }, 30000, 'оба ORDERED', 500);
    const ms = await mockState();
    const log = h.file(`logs/${first.id}.log`);
    say(`applepay-qr: ${fin.orders.map((o) => o.orderNo).join(', ')} · CDP-кликов ${ms.sessions.reduce((a, x) => a + (x.checkout.applePayTrusted ?? 0), 0)}`);
    assert.ok(/клик Apple Pay через CDP|QR Apple Pay показан \(клик: cdp\)/.test(log), 'QR открыт настоящим кликом через CDP');
    assert.ok(/открываю ещё раз/.test(log), 'повторное открытие после истечения');
    assert.ok(ms.sessions.every((x) => !x.bag.length || x.checkout.applePayTrusted), 'программный клик QR не открыл');
    assert.equal(both, 0, 'два QR одновременно не показывались');
    assert.ok(h.events().filter((e) => e.type === 'applepay.qr').length >= 2, 'событие applepay.qr');
    assert.ok(!tg.calls.some((c) => c.method === 'sendPhoto'), 'скриншот QR в Telegram не шлём (sendQrScreenshot=false)');
  } finally { clearInterval(watch); }
};

/** Зависание → окно в очереди внимания (≤ порог + 2 с) → «Продолжить автоматику» → путь дошёл. */
scenarios['stuck-human'] = async () => {
  await startMock({ OPEN_AFTER: '5', HANG_STORES: '1' });
  await startTelegram(); await startHooks();
  const h = await startBot('stuck', botConfig('stuck', 5, { watchdog: { thresholds: { FULFILLMENT: 6 } }, payment: { stopBeforePay: true } }), botSecrets());
  const s = await waitFor(async () => { const x = await h.state(); return x.attention.active?.browser === 'b01' ? x : null; }, 90000, 'окно в очереди внимания', 250);
  const ev = h.events();
  const st = ev.find((e) => e.type === 'state' && e.state === 'FULFILLMENT');
  const att = ev.find((e) => e.type === 'attention');
  const lag = (att.ts - st.ts) / 1000;
  say(`stuck-human: ${s.attention.active.reason} через ${lag.toFixed(1)} с после входа в FULFILLMENT — ${s.attention.active.text}`);
  assert.ok(lag <= 6 + 2 + 0.5, `окно вперёд не позже порога + 2 с (${lag.toFixed(1)} с)`);
  assert.ok(ev.some((e) => e.type === 'watchdog'), 'сработал сторож');
  assert.ok(tg.calls.some((c) => c.method === 'sendMessage' && /Нужен человек/.test(c.params.text)), 'Telegram: нужен человек');
  // «человек» разобрался: магазины появились, жмём «Продолжить автоматику» на плашке
  await mockConfig({ hangStores: false });
  const { cdp, page } = await humanPage(h, 'b01', '_s=');
  await page.locator('apple-drop-assistant button[data-ada="resume"]').click();
  await cdp.close();
  const fin = await waitFor(async () => { const x = await h.state(); return x.browsers[0].state === 'REVIEW' ? x : null; }, 60000, 'дошли до Review', 500);
  say(`stuck-human: после «Продолжить» → ${fin.browsers[0].state}; очередь внимания: ${fin.attention.active ? fin.attention.active.browser : 'пусто'}`);
  assert.ok(!fin.attention.items.some((x) => x.reason === 'stuck'), 'зависание снято');
};

/** Прокси: форвардер с логином (HTTP и SOCKS5), хаб мимо прокси, PROXY_DOWN при падении. */
scenarios.proxy = async () => {
  await startMock({ OPEN_AFTER: '5' });
  await startTelegram(); await startHooks();
  const px1 = await startHttpUpstream('px1', 18901);
  const px2 = await startSocksUpstream(18902);
  const proxies = [{ id: 'px1', label: 'AE-1', url: 'http://u:p@127.0.0.1:18901' }, { id: 'px2', label: 'AE-2', url: 'socks5://su:sp@127.0.0.1:18902' }];
  // 1) по умолчанию 127.0.0.1 (хаб и мок) Chrome пускает мимо прокси
  let h = await startBot('proxy-a', botConfig('proxy-a', 5, { proxies: { mode: 'all' }, payment: { stopBeforePay: true } }), botSecrets({ proxies }));
  await waitFor(async () => (await h.state()).browsers[0]?.online, 30000, 'браузер через прокси подключился к хабу');
  await sleep(2000);
  const sa = await h.state();
  const via = sa.proxies.find((p) => p.id === 'px1');
  say(`proxy: (a) хаб через прокси? ${Object.keys(via?.targets ?? {}).filter((k) => k.endsWith(`:${HUB_PORT}`)).length ? 'да' : 'нет'} · цели форвардера: ${Object.keys(via?.targets ?? {}).join(', ') || '—'}`);
  assert.ok(!Object.keys(via?.targets ?? {}).some((k) => k.endsWith(`:${HUB_PORT}`)), 'соединение с хабом идёт мимо прокси');
  await stopBot(h);
  current = null;
  // 2) <-loopback>: весь трафик мока через прокси — оба протокола, логин в форвардере
  await fetch(`${MOCK}/__reset`, { method: 'POST' });
  h = await startBot('proxy-b', botConfig('proxy-b', 5, { fleet: { browsers: 2, claimersPerOrder: 1 }, proxies: { mode: 'all', bypassLoopback: false }, orders: [order('A', 0), order('B', 1)], payment: { stopBeforePay: true } }), botSecrets({ proxies, cards: [CARD1, CARD2] }));
  await waitFor(async () => { const x = await h.state(); return x.browsers.filter((b) => b.state === 'REVIEW').length === 2; }, 90000, 'оба через прокси до Review', 500);
  const ms = await mockState();
  const addrs = new Set(ms.sessions.filter((x) => x.bag.length).map((x) => x.addr));
  say(`proxy: (b) выходные адреса сессий с корзиной: ${[...addrs].join(', ')} · px1 plain ${px1.stats.plain}, socks connect ${px2.stats.connect}`);
  assert.ok(addrs.has('px1'), 'HTTP-прокси с логином (выход px1)');
  assert.ok(addrs.has('127.0.0.2'), 'SOCKS5 с логином (выход 127.0.0.2)');
  // 3) апстрим px1 умер → PROXY_DOWN, браузер с заказом — к человеку
  await px1.close();
  await waitFor(async () => h.events().some((e) => e.type === 'proxy.down' && e.proxy === 'px1'), 30000, 'событие proxy.down', 500);
  const s3 = await waitFor(async () => { const x = await h.state(); return x.browsers.some((b) => b.status === 'PROXY_DOWN') ? x : null; }, 10000, 'PROXY_DOWN');
  say(`proxy: (c) ${s3.browsers.map((b) => `${b.id}:${b.status}`).join(' ')} · внимание: ${s3.attention.items.map((i) => `${i.browser}/${i.reason}`).join(', ')}`);
  assert.ok(s3.attention.items.some((i) => i.reason === 'proxy_down'), 'браузер с заказом — к человеку, IP не меняем');
  assert.ok(hooks.got.some((x) => x.json?.event === 'proxy.down'), 'вебхук proxy.down');
};

/** 403 → blocked: без заказа — перезапуск на запасном прокси; с заказом — к человеку. */
scenarios.blocked = async () => {
  await startMock({ OPEN_AFTER: '5', BLOCK_AFTER_SESSIONS: '2' });
  await startTelegram(); await startHooks();
  await startHttpUpstream('px1', 18911); await startHttpUpstream('px2', 18912); await startHttpUpstream('px3', 18913);
  await fetch(`${MOCK}/__addr_sessions`, { method: 'POST', body: JSON.stringify({ addr: 'px1', n: 2 }) }); // px1 уже «засвечен»
  const proxies = ['px1', 'px2', 'px3'].map((id, i) => ({ id, label: id.toUpperCase(), url: `http://u:p@127.0.0.1:${18911 + i}` }));
  const cfg = botConfig('blocked', 5, { fleet: { browsers: 2, claimersPerOrder: 1 }, proxies: { mode: 'all', bypassLoopback: false, relaunchOnBlock: true }, orders: [order('A', 0), order('B', 1)], payment: { stopBeforePay: true } });
  const h = await startBot('blocked', cfg, botSecrets({ proxies, cards: [CARD1, CARD2] }));
  // b01 (px1) заблокирован сразу → новый браузер на px3
  const s = await waitFor(async () => { const x = await h.state(); return x.browsers.some((b) => b.id === 'b03') && x.browsers.filter((b) => b.state === 'REVIEW').length === 2 ? x : null; }, 120000, 'b03 вместо заблокированного b01, оба на Review', 1000);
  say(`blocked: ${s.browsers.map((b) => `${b.id}(${b.proxy}):${b.status}/${b.state}`).join(' ')}`);
  assert.equal(s.browsers.find((b) => b.id === 'b01').status, 'RETIRED', 'b01 закрыт');
  assert.equal(s.browsers.find((b) => b.id === 'b03').proxy, 'PX3', 'новый профиль на запасном прокси');
  const ev1 = h.events().find((e) => e.type === 'browser.blocked' && e.browser === 'b01');
  assert.ok(ev1 && ev1.relaunched === 'b03', 'событие browser.blocked с перезапуском');
  // b02 с заказом: px2 засветился → 403 при перезагрузке → к человеку, без перезапуска
  await fetch(`${MOCK}/__addr_sessions`, { method: 'POST', body: JSON.stringify({ addr: 'px2', n: 5 }) });
  await h.act('reload', 'b02');
  const s2 = await waitFor(async () => { const x = await h.state(); return x.attention.items.some((i) => i.browser === 'b02' && i.reason === 'blocked') ? x : null; }, 40000, 'b02 с заказом → человек', 500);
  say(`blocked: b02 → ${s2.browsers.find((b) => b.id === 'b02').status}/${s2.browsers.find((b) => b.id === 'b02').state}, внимание ${s2.attention.items.map((i) => `${i.browser}/${i.reason}`).join(',')}`);
  assert.notEqual(s2.browsers.find((b) => b.id === 'b02').status, 'RETIRED', 'браузер с заказом не перезапущен');
  assert.ok(!s2.browsers.some((b) => b.id === 'b04'), 'нового браузера для b02 нет');
};

/** Капча на шаге (CAPTCHA_AT=bag) → очередь внимания → «человек» проходит → путь дошёл. */
scenarios.captcha = async () => {
  await startMock({ OPEN_AFTER: '5', CAPTCHA_AT: 'bag' });
  await startTelegram(); await startHooks();
  const h = await startBot('captcha', botConfig('captcha', 5, { payment: { stopBeforePay: true } }), botSecrets());
  const s = await waitFor(async () => { const x = await h.state(); return x.attention.active?.reason === 'captcha' ? x : null; }, 90000, 'капча → человек', 400);
  say(`captcha: ${s.browsers[0].state} — ${s.attention.active.text}`);
  const { cdp, page } = await humanPage(h, 'b01', '/ae/shop/bag');
  await page.click('#captcha-check');
  await cdp.close();
  const fin = await waitFor(async () => { const x = await h.state(); return x.browsers[0].state === 'REVIEW' ? x : null; }, 60000, 'после капчи до Review', 500);
  const ms = await mockState();
  assert.ok(ms.sessions.some((x) => x.captchaPassed), 'капча пройдена настоящим кликом');
  assert.ok(!fin.attention.items.some((i) => i.reason === 'captcha'), 'очередь внимания освободилась');
  assert.ok(h.events().some((e) => e.type === 'human.needed' && e.reason === 'captcha'), 'human.needed captcha');
};

/** Add to Bag прямым запросом с токеном сессии: корзина подтверждена, дублей нет. */
scenarios['direct-requests'] = async () => {
  await startMock({ OPEN_AFTER: '5' });
  await startTelegram(); await startHooks();
  const h = await startBot('direct', botConfig('direct', 5, { fleet: { directAtb: true }, payment: { stopBeforePay: true } }), botSecrets());
  await waitFor(async () => (await h.state()).browsers[0].state === 'REVIEW', 90000, 'Review', 500);
  const ms = await mockState();
  const sess = ms.sessions.find((x) => x.bag.length);
  say(`direct-requests: прямых Add to Bag ${sess.atbDirect}, в корзине ${sess.bag.map((i) => `${i.part}×${i.qty}`).join(',')}`);
  assert.ok(sess.atbDirect >= 1, 'Add to Bag ушёл прямым запросом');
  assert.equal(sess.bag.length, 1);
  assert.equal(sess.bag[0].qty, 1, 'без дублей');
  assert.ok(/Add to Bag прямым запросом/.test(h.file('logs/b01.log')));
};

/** Оркестратор убит после ASSIGN → браузер сам дошёл до оплаты; после перезапуска состояние восстановлено. */
scenarios['hub-crash'] = async () => {
  await startMock({ OPEN_AFTER: '6', THREEDS_MS: '1500', ATTACH_DELAY_MS: '2500' });
  await startTelegram(); await startHooks();
  const cfg = botConfig('crash', 6);
  const sec = botSecrets();
  let h = await startBot('crash', cfg, sec);
  await waitFor(async () => ['CLAIMED', 'IN_BAG'].includes((await h.state()).orders[0].state), 60000, 'ASSIGN', 300);
  say('hub-crash: ASSIGN есть — убиваю оркестратор (SIGKILL)');
  h.proc.kill('SIGKILL');
  await new Promise((r) => h.proc.once('exit', r));
  const ms = await waitFor(async () => { const m = await mockState(); return m.orders.length ? m : null; }, 90000, 'браузер без хаба оформил заказ', 500);
  say(`hub-crash: без оркестратора оформлен ${ms.orders[0].orderNo}; перезапускаю оркестратор`);
  h = await startBot('crash', cfg, sec, { fresh: false });
  const s = await waitFor(async () => { const x = await h.state(); return x.orders[0].state === 'ORDERED' && x.browsers[0].online ? x : null; }, 40000, 'состояние восстановлено', 500);
  say(`hub-crash: после перезапуска ${s.orders[0].orderNo}, браузер ${s.browsers[0].id} PID ${s.browsers[0].pid} подхвачен`);
  assert.equal(s.orders[0].orderNo, ms.orders[0].orderNo, 'номер заказа восстановлен из браузера');
  assert.equal(ms.orders.length, 1, 'без дублей');
  assert.ok(/подхватываю/.test(h.file('hub.log')), 'живой браузер подхвачен, не перезапущен');
};

/** Все события §12 уходят в тестовый приёмник; подпись HMAC верна; карт и токенов нет. */
scenarios.notify = async () => {
  await startMock({ OPEN_AFTER: '12', STORE_CLOSED: 'backsoon', THREEDS_MS: '1000' });
  await startTelegram(); await startHooks();
  const h = await startBot('notify', botConfig('notify', 12), botSecrets());
  await waitFor(async () => (await h.state()).orders[0].state === 'ORDERED', 120000, 'ORDERED', 500);
  const extra = {
    'strategy.switched': { browsers: ['b01'], to: 'refresh', reason: 'тест' },
    'applepay.qr': { browser: 'b01', orderId: 'A', recipient: RECIPIENTS.r1 },
    'card.declined': { browser: 'b01', orderId: 'A', cardLast4: '1111', text: 'Your payment was declined.', recipient: RECIPIENTS.r1 },
    'card.swapped': { orderId: 'A', from: '1111', to: '4242' },
    'cards.exhausted': { cardId: 'c1', cardLast4: '1111' },
    'human.needed': { browser: 'b01', reason: 'captcha', text: 'тест', recipient: RECIPIENTS.r1 },
    'browser.blocked': { browser: 'b01', proxy: 'AE-1', status: 403 },
    'proxy.down': { proxy: 'px1', error: 'тест', browsers: ['b01'] },
    'browser.dead': { browser: 'b01', orderId: 'A', placed: false },
    'run.summary': { text: 'тест' },
  };
  for (const [event, data] of Object.entries(extra)) await fetch(`http://127.0.0.1:${HUB_PORT}/api/test/emit`, { method: 'POST', headers: { 'x-token': h.token }, body: JSON.stringify({ event, ...data }) });
  const all = ['run.started', 'store.closed', 'store.opened', 'browser.admitted', 'strategy.switched', 'order.in_bag', 'pay.3ds', 'applepay.qr', 'order.placed', 'card.declined', 'card.swapped', 'cards.exhausted', 'human.needed', 'browser.blocked', 'proxy.down', 'browser.dead', 'run.summary'];
  await waitFor(() => all.every((e) => hooks.got.some((x) => x.json?.event === e)), 20000, 'все события в вебхуке');
  const missing = all.filter((e) => !hooks.got.some((x) => x.json?.event === e));
  say(`notify: вебхуков ${hooks.got.length}, Telegram-вызовов ${tg.calls.length}, нет: ${missing.join(',') || '—'}`);
  assert.ok(hooks.got.every((x) => x.sigOk), 'подпись HMAC на всех');
  assert.ok(hooks.got.every((x) => x.json.machine === 'test' && x.json.ts), 'конверт события');
  const tgTexts = tg.calls.filter((c) => c.method === 'sendMessage').map((c) => c.params.text);
  for (const re of [/Старт test/, /Apple Store закрыт/, /OPEN/, /Подтверди оплату/, /✅ Заказ W/, /Отказ карты \*\*\*\*1111/, /Нужен человек/, /Блокировка/, /Прокси px1/, /упал/]) assert.ok(tgTexts.some((t) => re.test(t)), `Telegram: ${re}`);
  assert.ok(!tgTexts.some((t) => /^🚪 Пустили/.test(t)), 'browser.admitted — только в статусе');
  assert.ok(tg.calls.some((c) => c.method === 'pinChatMessage'), 'закреплённый статус');
  assert.ok(tg.calls.some((c) => c.method === 'editMessageText' || c.method === 'sendMessage' && /пущено/.test(c.params.text)), 'живой статус');
  // команда из Telegram: только от allowedUserIds
  tg.updates.push({ update_id: 1, message: { message_id: 1, from: { id: 999 }, chat: { id: 42 }, text: '/status' } });
  tg.updates.push({ update_id: 2, message: { message_id: 2, from: { id: 7 }, chat: { id: 42 }, text: '/status' } });
  await waitFor(() => tg.calls.filter((c) => c.method === 'sendMessage' && /пущено \d+\/\d+/.test(c.params.text) && c.params.disable_notification).length >= 1, 15000, 'ответ на /status');
  assertNoLeaks(h);
};

// ---------- запуск ----------
const want = process.argv.slice(2);
const list = want.length ? want : ['bot-single', 'bot-pool', 'h1-refresh', 'h1-queue', 'card-decline', 'card-pool-empty', 'place-generic-error', 'applepay-qr', 'stuck-human', 'proxy', 'blocked', 'captcha', 'direct-requests', 'hub-crash', 'notify'];
if (!existsSync(BOT)) { console.error('нет bot/dist/bot.mjs — npm run test:bot собирает его сам'); process.exit(1); }
let failed = 0;
for (const name of list) {
  const fn = scenarios[name];
  if (!fn) { console.error(`нет сценария ${name}`); failed++; continue; }
  const s = Date.now();
  say(`▶ ${name}`);
  try {
    await fn();
    say(`✔ ${name} (${((Date.now() - s) / 1000).toFixed(0)} с)`);
  } catch (e) {
    failed++;
    say(`✘ ${name}: ${e.stack ?? e}`);
    await dump(name).catch(() => {});
  } finally {
    await teardown();
  }
}
say(failed ? `провалено: ${failed}` : 'все сценарии зелёные');
process.exit(failed ? 1 : 0);
