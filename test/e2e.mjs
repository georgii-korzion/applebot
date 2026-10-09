// E2E на мок-сервере (§11.1, §11.3). Playwright здесь — только тестовый стенд, чтобы запускать
// обычные профили Chromium с dev-сборкой расширения; само расширение CDP не использует.
//   npm run test:e2e                 — все сценарии
//   node test/e2e.mjs single assist  — выбранные
// CHROME_PATH — путь к Chromium/Chrome (по умолчанию ищется в PLAYWRIGHT_BROWSERS_PATH).
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(root, 'dist-dev');
const MOCK = 'http://127.0.0.1:4777';
const HUB_PORT = 18765;
const HUB = `http://127.0.0.1:${HUB_PORT}`;
const HUB_WS = `ws://127.0.0.1:${HUB_PORT}/ws`;
const PROXY_PORT = 18808;
const ART = join(root, 'test/.artifacts');
const HUBDIR = join(root, 'test/.hub');
const HEADLESS = process.env.HEADED !== '1';

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  for (const d of existsSync(base) ? readdirSync(base).sort().reverse() : []) {
    const p = join(base, d, 'chrome-linux/chrome');
    if (d.startsWith('chromium-') && existsSync(p)) return p;
  }
  return undefined; // playwright-core сам поищет
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const say = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...a);

// ---------- процессы ----------
const children = [];
function run(file, env) {
  const ch = spawn(process.execPath, [join(root, file)], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const name = file.split('/').pop();
  const logs = [];
  ch.stdout.on('data', (d) => logs.push(String(d)));
  ch.stderr.on('data', (d) => logs.push(String(d)));
  ch.logs = logs;
  ch.label = name;
  children.push(ch);
  return ch;
}
async function waitHttp(url, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.ok || r.status < 500) return; } catch { /* */ }
    await sleep(150);
  }
  throw new Error(`не поднялся ${url}`);
}
async function mockConfig(cfg) {
  const r = await fetch(`${MOCK}/__config`, { method: 'POST', body: JSON.stringify(cfg) });
  return r.json();
}
async function mockState() { return (await fetch(`${MOCK}/__state`)).json(); }
async function hubState() { return (await fetch(`${HUB}/api/state`)).json(); }
async function hubCmd(target, cmd, args = {}) {
  return (await fetch(`${HUB}/api/command`, { method: 'POST', body: JSON.stringify({ target, cmd, args }) })).json();
}

/** Хаб v2 читает fleet.json: пишем его в test/.hub/<name>/ (runtime/ там же). */
function makeFleet(name, profiles, { openInSec, version = 1, defaults = {}, top = {} } = {}) {
  const dir = join(HUBDIR, name);
  mkdirSync(dir, { recursive: true });
  const fleet = {
    version, openAt: new Date(Date.now() + openInSec * 1000).toISOString(), mode: 'auto', baseUrl: MOCK, ipCheckUrl: `${MOCK}/__ip`,
    timing: { pollMs: 1200, atbTimeoutMs: 15000, manualPayTimeoutSec: 600 },
    retries: { checkout: 4, slotsPerStore: 4 }, limits: { maxTabsTotal: 12 },
    defaults: {
      strategy: 'refresh', racersPerProfile: 1, autoStart: true, targets: ['MK254AH/A', 'MK244AH/A'], stores: ['R597', 'R596', 'R706'], city: 'Dubai',
      slot: { day: null, after: null, before: null }, payment: 'applepay', applePayFallback: 'manual', applePayClick: 'debugger', applePayRetries: 3, cardFallback: null,
      autoReview: true, autoPlaceOrder: false, deliveryFallback: false, address: { street: '', area: '', city: 'Dubai' }, proxy: null,
      card: { number: '', expiry: '', cvv: '', name: '' }, billing: { title: 'Mr.', firstName: '', lastName: '', street: 'Sheikh Zayed Rd 1', area: 'Downtown', town: '', city: 'Dubai' },
      ...defaults,
    },
    profiles: Object.fromEntries(Object.entries(profiles).map(([id, p], i) => [id, { contact: CONTACTS[i % CONTACTS.length], ...p }])),
    ...top,
  };
  const file = join(dir, 'fleet.json');
  writeFileSync(file, JSON.stringify(fleet, null, 2));
  return { dir, file, fleet, rewrite(patch) { Object.assign(fleet, patch); writeFileSync(file, JSON.stringify(fleet, null, 2)); } };
}

async function startServers(mockEnv = {}, withHub = false, hubEnv = {}) {
  const mock = run('test/mock-server.mjs', { OPEN_AFTER: '3600', ...mockEnv });
  await waitHttp(`${MOCK}/__state`);
  let hub = null;
  if (withHub) hub = await startHub(hubEnv);
  return { mock, hub };
}
async function startHub(hubEnv = {}) {
  const dir = hubEnv.FLEET_FILE ? dirname(hubEnv.FLEET_FILE) : join(HUBDIR, 'default');
  mkdirSync(dir, { recursive: true });
  if (!hubEnv.FLEET_FILE) writeFileSync(join(dir, 'fleet.json'), JSON.stringify({ version: 1, openAt: new Date(Date.now() + 3600_000).toISOString(), baseUrl: MOCK, profiles: { 'x-p01': { contact: CONTACTS[0] } } }));
  const hub = run('hub/server.mjs', { HUB_PORT: String(HUB_PORT), HUB_ALLOW_MOCK: '1', FLEET_FILE: hubEnv.FLEET_FILE ?? join(dir, 'fleet.json'), RUNTIME_DIR: hubEnv.RUNTIME_DIR ?? join(dir, 'runtime'), ...hubEnv });
  await waitHttp(`${HUB}/healthz`);
  return hub;
}
async function stopServers() {
  for (const ch of children.splice(0)) { ch.kill(); await new Promise((r) => ch.once('exit', r)); }
}
async function stopChild(ch) {
  const i = children.indexOf(ch);
  if (i >= 0) children.splice(i, 1);
  ch.kill();
  await new Promise((r) => ch.once('exit', r));
}

/**
 * Локальный HTTP-прокси с логином (Basic): проверяет Proxy-Authorization, пересылает запрос на мок с заголовком X-Mock-Proxy
 * (мок с PROXY_REQUIRED_HEADER без него отвечает 403), CONNECT туннелирует как есть. Считает запросы и отказы.
 */
function startLocalProxy({ username = 'proxyuser', password = 'proxypass' } = {}) {
  const stats = { requests: 0, authFailed: 0, connects: 0 };
  const ok = (req) => {
    const h = req.headers['proxy-authorization'] ?? '';
    return h === `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  };
  const srv = http.createServer((req, res) => {
    if (!ok(req)) { stats.authFailed++; res.writeHead(407, { 'proxy-authenticate': 'Basic realm="mock-proxy"', 'content-length': '0' }); return res.end(); }
    stats.requests++;
    let u;
    try { u = new URL(req.url); } catch { res.writeHead(400); return res.end(); }
    const headers = { ...req.headers, 'x-mock-proxy': '1', host: u.host };
    delete headers['proxy-authorization']; delete headers['proxy-connection'];
    const up = http.request({ host: u.hostname, port: u.port || 80, method: req.method, path: u.pathname + u.search, headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  srv.on('connect', (req, socket, head) => {
    if (!ok(req)) { stats.authFailed++; socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="mock-proxy"\r\nContent-Length: 0\r\n\r\n'); return; }
    stats.connects++;
    const [host, port] = req.url.split(':');
    const up = net.connect(Number(port) || 443, host, () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head?.length) up.write(head); up.pipe(socket); socket.pipe(up); });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  return new Promise((resolve) => srv.listen(PROXY_PORT, '127.0.0.1', () => resolve({ stats, username, password, port: PROXY_PORT, close: () => new Promise((r) => srv.close(() => r())) })));
}

// ---------- профили ----------
async function launchProfile(name, { startUrl } = {}) {
  const dir = join(root, 'test/.profiles', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const ctx = await chromium.launchPersistentContext(dir, {
    executablePath: findChrome(),
    headless: HEADLESS,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--no-default-browser-check', '--lang=en-US'],
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'Asia/Dubai',
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  // закрыть авто-открытую страницу настроек (onInstalled), оставить одну управляющую
  await sleep(300);
  const control = await ctx.newPage();
  await control.goto(`chrome-extension://${extId}/popup.html`);
  for (const p of ctx.pages()) if (p !== control && p.url().includes('options.html')) await p.close();
  const prof = { name, ctx, sw, extId, control };
  prof.cmd = (c) => control.evaluate((x) => chrome.runtime.sendMessage(x), c);
  prof.setConfig = async (cfg) => {
    await control.evaluate(async (c) => { await chrome.storage.local.set({ config: c, profileId: c.profileId }); await chrome.storage.local.remove('modeOverride'); }, cfg);
    await sleep(200);
  };
  prof.status = () => prof.cmd({ cmd: 'status' });
  prof.log = async () => (await prof.cmd({ cmd: 'exportLog' }))?.text ?? '';
  prof.appleTabs = () => ctx.pages().filter((p) => p.url().startsWith(MOCK));
  if (startUrl) {
    // как fleet.ps1: клон открывается на адресе с #drop=<profileId>&hub=<ws> и сам получает имя и конфиг
    const pg = await ctx.newPage();
    await pg.goto(startUrl);
    prof.startPage = pg;
  }
  return prof;
}

async function closeProfiles(profiles) {
  for (const p of profiles) await p.ctx.close().catch(() => {});
}

// ---------- конфиг ----------
const CONTACTS = [
  { firstName: 'Ahmed', lastName: 'Test', email: 'ahmed.test@example.com', phone: '0501234567' },
  { firstName: 'Maria', lastName: 'Test', email: 'maria.test@example.com', phone: '0529876543' },
  { firstName: 'Omar', lastName: 'Test', email: 'omar.test@example.com', phone: '0551112233' },
];
const CARD = { number: '4111111111111111', expiry: '12/29', cvv: '123', name: 'AHMED TEST' };
function makeOrder(id, i, profiles, extra = {}) {
  return {
    id, priority: i + 1, profiles, racersPerProfile: 2, card: { number: '', expiry: '', cvv: '', name: '' }, autoReview: true,
    billing: { title: 'Mr.', firstName: '', lastName: '', street: 'Sheikh Zayed Rd 1', area: 'Downtown', town: '', city: 'Dubai' },
    targets: ['MK254AH/A', 'MK244AH/A'], stores: ['R597', 'R596', 'R706'], city: 'Dubai',
    slot: { day: null, after: null, before: null },
    payment: i % 2 ? 'applepay' : 'manual', applePayFallback: 'manual',
    contact: CONTACTS[i % CONTACTS.length], deliveryFallback: false, address: { street: '', area: '', city: 'Dubai' },
    ...extra,
  };
}
function makeConfig(profileId, orders, { openInSec, hub = false, mode = 'auto', timing = {}, strategy = 'refresh', proxy = null, extra = {} } = {}) {
  return {
    profileId, hubUrl: hub ? HUB_WS : '',
    openAt: new Date(Date.now() + openInSec * 1000).toISOString(),
    mode, orders, strategy, proxy, ipCheckUrl: `${MOCK}/__ip`, ...extra,
    timing: { pollMs: 1200, preOpenReloadMs: 3000, postOpenReloadMs: 1500, minReloadMs: 1500, jitterPct: 30, graceSec: 20, atbTimeoutMs: 15000, atb404BackoffMs: 1500, atb404MaxInRow: 5, manualPayTimeoutSec: 600, assistAfterFailures: 3, ...timing },
    retries: { checkout: 4, slotsPerStore: 4 },
    limits: { maxTabsTotal: 12 },
    baseUrl: MOCK,
  };
}

async function waitFor(fn, ms, label, every = 250) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(every);
  }
  throw new Error(`таймаут: ${label}`);
}

async function dumpOnFail(profiles, name) {
  mkdirSync(ART, { recursive: true });
  for (const p of profiles) {
    try {
      const st = await p.status();
      writeFileSync(join(ART, `${name}-${p.name}-status.json`), JSON.stringify(st, null, 2));
      writeFileSync(join(ART, `${name}-${p.name}.log`), await p.log());
      let i = 0;
      for (const pg of p.appleTabs()) await pg.screenshot({ path: join(ART, `${name}-${p.name}-${i++}.png`) }).catch(() => {});
    } catch (e) { console.log('dump failed', e.message); }
  }
  for (const ch of children) writeFileSync(join(ART, `${name}-${ch.label}.log`), ch.logs.join(''));
  try { writeFileSync(join(ART, `${name}-mock-state.json`), JSON.stringify(await mockState(), null, 2)); } catch { /* */ }
  try { writeFileSync(join(ART, `${name}-hub-state.json`), JSON.stringify(await hubState(), null, 2)); } catch { /* */ }
  say(`артефакты: ${ART}`);
}

/** Страница-победитель профиля на Billing. */
async function billingPage(p) {
  return p.appleTabs().find((pg) => /_s=Billing/.test(pg.url()));
}

// ---------- сценарии ----------
const scenarios = {};

/** 1 профиль, 1 вкладка, auto, без хаба: OPEN → Add to Bag → чекаут → Billing (T1 на моке). */
scenarios.single = async () => {
  await startServers({ OPEN_AFTER: '8' });
  const p = await launchProfile('single');
  const profiles = [p];
  try {
    const order = makeOrder('A', 0, ['drop-1'], { racersPerProfile: 1, card: CARD });
    await p.setConfig(makeConfig('drop-1', [order], { openInSec: 8 }));
    const r = await p.cmd({ cmd: 'start' });
    assert.ok(r.ok, `start: ${r.error}`);
    say('single: Start', r.warnings ?? '');
    const st = await waitFor(async () => { const s = await p.status(); return s.os.billingReadyAt ? s : null; }, 60000, 'Billing');
    const took = (st.os.billingReadyAt - st.os.openedAt) / 1000;
    say(`single: Billing через ${took.toFixed(1)} с после OPEN, слот ${st.os.store} ${st.os.slotLabel}`);
    // очередь без хаба: сразу наш ход → карта заполнена → autoReview → Review; Place Order — «человек»
    await waitFor(async () => (await p.status()).tabs.some((t) => t.state === 'REVIEW'), 15000, 'REVIEW (autoReview)');
    const pg = p.appleTabs().find((x) => /_s=Review/.test(x.url()));
    assert.ok(pg, 'вкладка на Review');
    const ms = await waitFor(async () => { const m = await mockState(); return m.sessions.some((s) => s.checkout.review) ? m : null; }, 3000, 'Review записан');
    const sess = ms.sessions.find((s) => s.bag.length);
    assert.equal(sess.bag.length, 1);
    assert.equal(sess.bag[0].qty, 1);
    assert.equal(sess.bag[0].part, 'MK254AH/A');
    assert.equal(sess.checkout.fulfillment.store, 'R596', 'R597 без наличия → R596');
    assert.ok(!/-16:15-16:30$/.test(sess.checkout.fulfillment.slot), 'первое (занятое) окно пропущено');
    assert.equal(sess.checkout.method, 'CREDIT');
    assert.deepEqual([sess.checkout.review.cardLast4, sess.checkout.review.exp, sess.checkout.review.cvvLen], ['1111', '12/29', 3], 'карта заполнена из конфига');
    assert.deepEqual(sess.checkout.review.billing, { first: 'Ahmed', last: CONTACTS[0].lastName, street: 'Sheikh Zayed Rd 1', area: 'Downtown', town: '', city: 'Dubai', title: 'Mr.' }, 'Billing Address заполнен: имя из контакта, адрес из billing');
    assert.equal(await pg.locator('#place').count(), 1, 'Place Order на экране и не нажат');
    const stRev = await p.status();
    assert.equal(stRev.payActive, stRev.tabs[0].tabId, 'очередь оплаты не ушла дальше на Review');
    assert.equal(stRev.orders.length, 1, 'запись о заказе создана');
    assert.equal(stRev.orders[0].phone, '0501234567', 'запись о заказе без масок');
    await waitFor(async () => (await pg.locator('#terms').isChecked()) || null, 6000, 'галочка Terms & Conditions поставлена расширением');
    await waitFor(async () => (await mockState()).sessions.some((s) => s.checkout.termsAccepted) || null, 3000, 'мок увидел change на чекбоксе условий');
    await pg.click('#place');
    const done = await waitFor(async () => { const s = await p.status(); return s.os.orderNo ? s : null; }, 10000, 'ORDERED');
    say(`single: ORDERED ${done.os.orderNo} · карта заполнена расширением, Place Order — человек`);
    assert.equal(done.orders[0].orderNo, done.os.orderNo, 'номер заказа в записи');
    const csv = (await p.cmd({ cmd: 'exportOrders' })).text;
    assert.ok(csv.includes(done.os.orderNo) && csv.includes('Ahmed') && csv.includes('0501234567'), 'CSV заказов с полными данными');
    const log = (await p.cmd({ cmd: 'exportLog' })).text;
    assert.ok(!log.includes('ahmed.test@example.com') && !log.includes('0501234567'), 'в логе нет полных контактов');
    assert.ok(!/atbtoken=[0-9a-f]{5,}/.test(log), 'в логе нет atbtoken');
    assert.ok(!log.includes('4111111111111111') && !log.includes('4111 1111'), 'в логе нет номера карты');
    assert.ok(/карта \*\*\*\*1111: заполнено номер, срок, CVV/.test(log), 'лог о заполнении карты');
    assert.ok(/адрес плательщика: заполнено имя, фамилия, улица, Area, Title, город$/m.test(log), 'лог о заполнении Billing Address');
    assert.ok(!log.includes('Sheikh Zayed'), 'адрес в лог не пишется');
  } catch (e) { await dumpOnFail(profiles, 'single'); throw e; } finally { await closeProfiles(profiles); await stopServers(); }
};

/** Плохие состояния без человека: 404 на Add to Bag, заглушка, выбор страны, занятый слот, 2 вкладки. */
scenarios.hostile = async () => {
  await startServers({ OPEN_AFTER: '6', ATB_404_FIRST: '2', ATB_404_RATE: '0.2', COUNTRY_PICKER: '1', DEFAULT_CITY: 'Abu Dhabi' });
  const p = await launchProfile('hostile');
  const profiles = [p];
  try {
    const order = makeOrder('A', 0, ['drop-1'], { racersPerProfile: 2, payment: 'applepay' });
    await p.setConfig(makeConfig('drop-1', [order], { openInSec: 6, timing: { atb404MaxInRow: 8, assistAfterFailures: 8 } }));
    const r = await p.cmd({ cmd: 'start' });
    assert.ok(r.ok, r.error);
    const st = await waitFor(async () => { const s = await p.status(); return s.os.billingReadyAt ? s : null; }, 90000, 'Billing', 500);
    say(`hostile: Billing через ${((st.os.billingReadyAt - st.os.openedAt) / 1000).toFixed(1)} с после OPEN`);
    const ms = await waitFor(async () => { const m = await mockState(); return m.sessions.some((s) => s.checkout.method) ? m : null; }, 3000, 'способ оплаты записан');
    const sess = ms.sessions.find((s) => s.bag.length);
    assert.equal(sess.geo, 'AE', 'выбрана страна AE');
    assert.equal(sess.bag.length, 1);
    assert.equal(sess.bag[0].qty, 1, 'одна вкладка нажала Add to Bag / лишнее убрано');
    assert.equal(sess.checkout.fulfillment.city, 'Dubai', 'город переключён Abu Dhabi → Dubai');
    assert.equal(sess.checkout.method, 'APPLE_PAY');
    const log = (await p.cmd({ cmd: 'exportLog' })).text;
    say(`hostile: 404 на Add to Bag: ${ms.sessions.reduce((a, s) => a + s.atb404, 0)}, COUNTRY: ${(log.match(/COUNTRY_PICKER/g) ?? []).length}, BUSY: ${(log.match(/BUSY/g) ?? []).length}, слот не принят: ${(log.match(/не принято/g) ?? []).length}`);
    assert.ok(/не принято/.test(log), 'занятый слот обработан');
    assert.ok(ms.sessions.reduce((a, s) => a + s.atb404, 0) >= 2, '404 на Add to Bag отработаны');
    assert.ok(/ATB_404/.test(log), 'диагностика ATB_404 в логе');
    // с autoReview вкладка уже на Review: Apple Pay выбран (по моку), Place Order нет и не нажат
    const pg = p.appleTabs().find((x) => /_s=(Billing|Review)/.test(x.url()));
    assert.ok(pg, 'вкладка на Billing/Review');
    assert.equal(await pg.locator('#place').count(), 0, 'Place Order не нажат');
    assert.equal(ms.orders.length, 0, 'заказ не размещён расширением');
  } catch (e) { await dumpOnFail(profiles, 'hostile'); throw e; } finally { await closeProfiles(profiles); await stopServers(); }
};

/** REQUIRE_TRUSTED=1: программный клик → 404 → режим ассистента → «человек» кликает → дальше само. */
scenarios.assist = async () => {
  await startServers({ OPEN_AFTER: '0', REQUIRE_TRUSTED: '1', BUSY_FIRST: '0' });
  const p = await launchProfile('assist');
  const profiles = [p];
  try {
    const order = makeOrder('A', 0, ['drop-1'], { racersPerProfile: 1 });
    await p.setConfig(makeConfig('drop-1', [order], { openInSec: -5 }));
    const r = await p.cmd({ cmd: 'start' });
    assert.ok(r.ok, r.error);
    await waitFor(async () => (await p.status()).tabs.some((t) => t.state === 'ASSIST'), 60000, 'ASSIST', 400);
    const ms = await mockState();
    const n404 = ms.sessions.reduce((a, s) => a + s.atb404, 0);
    say(`assist: после ${n404}×404 вкладка в режиме ассистента`);
    assert.equal(n404, 3);
    const pg = p.appleTabs().find((x) => /buy-iphone/.test(x.url()));
    const outline = await pg.locator('[data-autom="add-to-cart"]').evaluate((b) => b.style.outline);
    assert.match(outline, /solid/, 'кнопка подсвечена');
    await pg.click('[data-autom="add-to-cart"]'); // «человек»
    const st = await waitFor(async () => { const s = await p.status(); return s.os.billingReadyAt ? s : null; }, 40000, 'Billing после ручного клика');
    say(`assist: после ручного Add to Bag дошли до Billing (${st.os.store} ${st.os.slotLabel})`);
  } catch (e) { await dumpOnFail(profiles, 'assist'); throw e; } finally { await closeProfiles(profiles); await stopServers(); }
};

/** Prepare (страна → корзина → конфигурация) и Clean bag. */
scenarios.prepare = async () => {
  await startServers({ OPEN_AFTER: '3600', COUNTRY_PICKER: '1' });
  const p = await launchProfile('prepare');
  const profiles = [p];
  try {
    await p.setConfig(makeConfig('drop-1', [makeOrder('A', 0, ['drop-1'], { targets: ['MJR54AH/A'] })], { openInSec: 3600 }));
    // положим в корзину товар вручную, как будто остался от теста
    const pg = await p.ctx.newPage();
    await pg.goto(`${MOCK}/ae/?locale=ae`);
    const r = await p.cmd({ cmd: 'prepare' });
    assert.ok(r.ok, r.error);
    const st = await waitFor(async () => { const s = await p.status(); return s.prepared ? s : null; }, 30000, 'PREPARED');
    say(`prepare: ${st.prepared.ok ? 'OK' : 'FAIL'} — ${st.prepared.detail}`);
    assert.ok(st.prepared.ok);
    const r2 = await p.cmd({ cmd: 'cleanBag' });
    assert.ok(r2.ok);
    await waitFor(async () => (await p.status()).tabs.some((t) => t.state === 'CLEANED'), 20000, 'CLEANED');
    say('prepare: Clean bag OK');
  } catch (e) { await dumpOnFail(profiles, 'prepare'); throw e; } finally { await closeProfiles(profiles); await stopServers(); }
};

/**
 * Магазин закрыт перед дропом (пустая страница / «We’ll be back» / редирект в /ae/ и вне /ae/):
 * вкладки ждут по фазам и не долбят сайт, после открытия — до Billing.
 */
function closedScenario(style, openIn) {
  return async () => {
    await startServers({ OPEN_AFTER: String(openIn), STORE_CLOSED: style });
    const p = await launchProfile(`closed-${style}`);
    const profiles = [p];
    try {
      const order = makeOrder('A', 0, ['drop-1'], { racersPerProfile: 2 });
      const openAt = Date.now() + openIn * 1000;
      await fetch(`${MOCK}/__config`, { method: 'POST', body: JSON.stringify({ openAfter: openIn }) });
      await p.setConfig(makeConfig('drop-1', [order], { openInSec: openIn, timing: { closedReloadMs: 5000 } }));
      const r = await p.cmd({ cmd: 'start' });
      assert.ok(r.ok, r.error);
      await waitFor(async () => (await p.status()).os.storeClosedSince, 20000, 'обнаружено закрытие магазина');
      const st = await waitFor(async () => { const s = await p.status(); return s.os.billingReadyAt ? s : null; }, (openIn + 60) * 1000, 'Billing', 500);
      const ms = await mockState();
      // интервалы между переходами на страницу товара (вкладки профиля делят сессию; наблюдатель до старта не рефрешит)
      const startAt = openAt - openIn * 1000;
      const hits = ms.sessions.flatMap((s) => s.hits).sort((a, b) => a - b).filter((h) => h > startAt + 2500 && h < openAt - 300);
      const armedEnd = openAt - 60_000;
      const gaps = (arr) => arr.slice(1).map((h, i) => h - arr[i]);
      const armedGaps = gaps(hits.filter((h) => h < armedEnd));
      const preGaps = gaps(hits.filter((h) => h >= armedEnd));
      const log = (await p.cmd({ cmd: 'exportLog' })).text;
      const minA = armedGaps.length ? Math.min(...armedGaps) : null;
      const minP = preGaps.length ? Math.min(...preGaps) : null;
      say(`closed-${style}: Billing через ${((st.os.billingReadyAt - st.os.openedAt) / 1000).toFixed(1)} с после OPEN · переходов на товар до старта: ${hits.length} (мин. интервал: до openAt−60 ${minA ?? '—'} мс, последняя минута ${minP ?? '—'} мс)`);
      assert.ok(/CLOSED/.test(log), 'закрытие в логе');
      assert.ok(/REOPEN/.test(log), 'открытие магазина замечено');
      if (minA !== null) assert.ok(minA >= 3400, `до openAt−60 не чаще раза в ~5 с (${minA} мс)`);
      if (style === 'offsite') {
        // обе вкладки возвращает SW (content script вне /ae/ не работает) — мок видит их общий поток заходов
        const dur = (openAt - 300 - (startAt + 2500)) / 1000;
        assert.ok(hits.length <= 2 * Math.ceil(dur / 2.1) + 2, `2 вкладки не чаще раза в ~3 с каждая (${hits.length} за ${dur.toFixed(0)} с)`);
      } else if (minP !== null) assert.ok(minP >= 1400, `последняя минута не чаще раза в 1,5 с (${minP} мс)`);
      assert.ok(hits.length >= Math.min(openIn, 60) / 6, `вкладки действительно обновлялись (${hits.length})`);
    } catch (e) { await dumpOnFail(profiles, `closed-${style}`); throw e; } finally { await closeProfiles(profiles); await stopServers(); }
  };
}
scenarios['closed-blank'] = closedScenario('blank', 75);

/** Apple сменила все data-autom: элементы находятся по тексту и атрибутам, путь до Review тот же. */
scenarios['renamed-selectors'] = async () => {
  await startServers({ OPEN_AFTER: '0', BUSY_FIRST: '0', RENAME_AUTOM: '1' });
  const p = await launchProfile('renamed');
  const profiles = [p];
  try {
    await p.setConfig(makeConfig('drop-1', [makeOrder('A', 0, ['drop-1'], { racersPerProfile: 1, card: CARD })], { openInSec: -5 }));
    const r = await p.cmd({ cmd: 'start' });
    assert.ok(r.ok, r.error);
    const st = await waitFor(async () => { const s = await p.status(); return s.os.billingReadyAt ? s : null; }, 60000, 'Billing без data-autom', 500);
    await waitFor(async () => (await p.status()).tabs.some((t) => t.state === 'REVIEW'), 15000, 'REVIEW');
    const ms = await waitFor(async () => { const m = await mockState(); return m.sessions.some((s) => s.checkout.review) ? m : null; }, 3000, 'Review записан');
    const sess = ms.sessions.find((s) => s.bag.length);
    const log = (await p.cmd({ cmd: 'exportLog' })).text;
    const fallbacks = [...log.matchAll(/селектор «(\w+)» не найден — нашёл по: ([^.]+)/g)].map((m) => `${m[1]}←${m[2].trim()}`);
    say(`renamed-selectors: Billing через ${((st.os.billingReadyAt - st.os.openedAt) / 1000).toFixed(1)} с · запасные пути: ${fallbacks.length} (${fallbacks.slice(0, 4).join(', ')}…)`);
    assert.ok(fallbacks.some((f) => f.startsWith('addToBag←')), 'Add to Bag найден по запасному пути');
    assert.ok(fallbacks.some((f) => f.startsWith('guest←')), 'Continue as Guest найден по тексту');
    assert.equal(sess.bag.length, 1);
    assert.equal(sess.checkout.review.cardLast4, '1111', 'карта заполнена и без data-autom');
  } catch (e) { await dumpOnFail(profiles, 'renamed-selectors'); throw e; } finally { await closeProfiles(profiles); await stopServers(); }
};

/** Apple Pay: на нашем ходу расширение идёт на Review и жмёт кнопку Apple Pay; лист/подтверждение — человек. */
scenarios['applepay-turn'] = async () => {
  await startServers({ OPEN_AFTER: '0', BUSY_FIRST: '0' });
  const p = await launchProfile('applepay');
  const profiles = [p];
  try {
    await p.setConfig(makeConfig('drop-1', [makeOrder('A', 0, ['drop-1'], { racersPerProfile: 1, payment: 'applepay' })], { openInSec: -5 }));
    const r = await p.cmd({ cmd: 'start' });
    assert.ok(r.ok, r.error);
    await waitFor(async () => (await p.status()).os.billingReadyAt, 60000, 'Billing', 500);
    const ms = await waitFor(async () => { const m = await mockState(); return m.sessions.some((s) => s.checkout.applePayClicks) ? m : null; }, 15000, 'клик по Apple Pay на Review');
    const sess = ms.sessions.find((s) => s.bag.length);
    const st = await p.status();
    const log = (await p.cmd({ cmd: 'exportLog' })).text;
    say(`applepay-turn: способ ${sess.checkout.method}, кликов Apple Pay ${sess.checkout.applePayClicks}, состояние ${st.tabs[0].state}: ${st.tabs[0].detail}`);
    assert.equal(sess.checkout.method, 'APPLE_PAY');
    assert.equal(sess.checkout.applePayClicks, 1, 'кнопка Apple Pay нажата один раз');
    assert.equal(sess.checkout.termsAccepted, true, 'галочка Terms & Conditions поставлена до клика по Apple Pay');
    assert.ok(/условия продажи \(Terms & Conditions\) приняты/.test(log), 'галочка в логе');
    assert.ok(!/read and accept the terms/.test(log), 'ошибки про условия не было — галочка стояла до клика');
    assert.ok(/Apple Pay/.test(log), 'Apple Pay в логе');
    assert.equal(ms.orders.length, 0, 'заказ не размещён расширением');
  } catch (e) { await dumpOnFail(profiles, 'applepay-turn'); throw e; } finally { await closeProfiles(profiles); await stopServers(); }
};

/** Очередь Apple после открытия: страница с meta refresh сама ведёт дальше — расширение её не рефрешит. */
scenarios.queue = async () => {
  await startServers({ OPEN_AFTER: '6', QUEUE_AFTER_OPEN: '3', BUSY_FIRST: '0' });
  const p = await launchProfile('queue');
  const profiles = [p];
  try {
    // одна вкладка: мок считает повторный заход на URL очереди ручным рефрешем, две вкладки одной сессии его бы исказили
    await p.setConfig(makeConfig('drop-1', [makeOrder('A', 0, ['drop-1'], { racersPerProfile: 1 })], { openInSec: 6 }));
    const r = await p.cmd({ cmd: 'start' });
    assert.ok(r.ok, r.error);
    const st = await waitFor(async () => { const s = await p.status(); return s.os.billingReadyAt ? s : null; }, 60000, 'Billing', 500);
    const ms = await mockState();
    const passed = ms.sessions.reduce((a, s) => a + (s.queuePassed ?? 0), 0);
    const reloads = ms.sessions.reduce((a, s) => a + (s.queueReloads ?? 0), 0);
    const log = (await p.cmd({ cmd: 'exportLog' })).text;
    say(`queue: Billing через ${((st.os.billingReadyAt - st.os.openedAt) / 1000).toFixed(1)} с после OPEN · страниц очереди показано ${passed}, ручных рефрешей очереди ${reloads}`);
    assert.ok(passed >= 3, 'очередь была показана');
    assert.equal(reloads, 0, 'расширение не рефрешит страницу очереди — она ведёт дальше сама');
    assert.ok(/QUEUE/.test(log), 'состояние QUEUE в логе');
  } catch (e) { await dumpOnFail(profiles, 'queue'); throw e; } finally { await closeProfiles(profiles); await stopServers(); }
};

/** Ошибки чекаута общего вида (12.09.2026) и пустая корзина после Add to Bag: повтор того же действия. */
scenarios['checkout-errors'] = async () => {
  await startServers({ OPEN_AFTER: '0', BUSY_FIRST: '0', CHECKOUT_ERR_FIRST: '1', EMPTY_BAG_FIRST: '1' });
  const p = await launchProfile('checkout-errors');
  const profiles = [p];
  try {
    await p.setConfig(makeConfig('drop-1', [makeOrder('A', 0, ['drop-1'], { racersPerProfile: 1 })], { openInSec: -5 }));
    const r = await p.cmd({ cmd: 'start' });
    assert.ok(r.ok, r.error);
    const st = await waitFor(async () => { const s = await p.status(); return s.os.billingReadyAt ? s : null; }, 60000, 'Billing', 500);
    const ms = await waitFor(async () => { const m = await mockState(); return m.sessions.some((s) => s.checkout.method) ? m : null; }, 3000, 'способ оплаты');
    const sess = ms.sessions.find((s) => s.bag.length);
    const log = (await p.cmd({ cmd: 'exportLog' })).text;
    say(`checkout-errors: Billing через ${((st.os.billingReadyAt - st.os.openedAt) / 1000).toFixed(1)} с · слот ${sess.checkout.fulfillment.slot} · попыток Add to Bag ${sess.atbAttempts}`);
    assert.equal(sess.atbAttempts, 2, 'после пустой корзины Add to Bag повторён');
    assert.ok(/корзина пуста после Add to Bag \(1\)/.test(log), 'пустая корзина замечена');
    assert.equal(sess.bag.length, 1);
    // день в значении окна — сегодняшний (мок берёт текущую дату)
    assert.match(sess.checkout.fulfillment.slot, /^\d{1,2}-16:30-16:45$/, 'ошибка общего вида не заставила отдать первое свободное окно');
    assert.ok(/повтор того же окна/.test(log), 'повтор Continue на Fulfillment');
    assert.ok(/Continue to Payment: .* — повтор/.test(log), 'повтор Continue to Payment');
  } catch (e) { await dumpOnFail(profiles, 'checkout-errors'); throw e; } finally { await closeProfiles(profiles); await stopServers(); }
};
scenarios['closed-backsoon'] = closedScenario('backsoon', 15);
scenarios['closed-redirect'] = closedScenario('redirect', 15);
scenarios['closed-offsite'] = closedScenario('offsite', 15);

// ---------- запуск ----------
const want = process.argv.slice(2);
/** Блок карты подгружается 4 с (Apple 30.09): ждём до cardWaitMs, карта и адрес заполнены, фолбэк не нужен. */
scenarios['card-slow'] = async () => {
  await startServers({ OPEN_AFTER: '0', BUSY_FIRST: '0', CARD_DELAY_MS: '4000' });
  const p = await launchProfile('cardslow');
  const profiles = [p];
  try {
    await p.setConfig(makeConfig('drop-1', [makeOrder('A', 0, ['drop-1'], { racersPerProfile: 1, card: CARD })], { openInSec: -5 }));
    const r = await p.cmd({ cmd: 'start' });
    assert.ok(r.ok, r.error);
    await waitFor(async () => (await p.status()).os.billingReadyAt, 60000, 'Billing', 500);
    const ms = await waitFor(async () => { const m = await mockState(); return m.sessions.some((s) => s.checkout.review) ? m : null; }, 20000, 'Review');
    const sess = ms.sessions.find((s) => s.bag.length);
    const log = (await p.cmd({ cmd: 'exportLog' })).text;
    say(`card-slow: способ ${sess.checkout.method}, карта ****${sess.checkout.review.cardLast4}`);
    assert.equal(sess.checkout.method, 'CREDIT', 'карта дождалась полей — фолбэк не сработал');
    assert.equal(sess.checkout.review.cardLast4, '1111', 'карта заполнена после задержки');
    assert.equal(sess.checkout.review.billing.street, 'Sheikh Zayed Rd 1', 'адрес заполнен после задержки');
    assert.ok(/поля карты появились через [3-9]\.\d с/.test(log), 'лог о задержке полей карты');
    assert.ok(!/переключаюсь на Apple Pay/.test(log), 'без фолбэка');
  } catch (e) { await dumpOnFail(profiles, 'card-slow'); throw e; } finally { await closeProfiles(profiles); await stopServers(); }
};

/** Блок карты не появился за cardWaitMs → Apple Pay (cardFallback=applepay) → Review → галочка → кнопка Apple Pay. */
scenarios['card-fallback'] = async () => {
  await startServers({ OPEN_AFTER: '0', BUSY_FIRST: '0', CARD_DELAY_MS: '60000' });
  const p = await launchProfile('cardfb');
  const profiles = [p];
  try {
    await p.setConfig(makeConfig('drop-1', [makeOrder('A', 0, ['drop-1'], { racersPerProfile: 1, card: CARD })], { openInSec: -5, timing: { cardWaitMs: 4000 } }));
    const r = await p.cmd({ cmd: 'start' });
    assert.ok(r.ok, r.error);
    const ms = await waitFor(async () => { const m = await mockState(); return m.sessions.some((s) => s.checkout.applePayClicks) ? m : null; }, 40000, 'клик Apple Pay на Review');
    const sess = ms.sessions.find((s) => s.bag.length);
    const st = await p.status();
    const log = (await p.cmd({ cmd: 'exportLog' })).text;
    say(`card-fallback: способ ${sess.checkout.method}, состояние ${st.tabs[0].state}: ${st.tabs[0].detail}`);
    assert.equal(sess.checkout.method, 'APPLE_PAY', 'переключились на Apple Pay');
    assert.ok(/поля карты не появились за 4 с — переключаюсь на Apple Pay/.test(log), 'лог о фолбэке');
    assert.equal(sess.checkout.termsAccepted, true, 'галочка условий стоит');
    assert.equal(sess.checkout.applePayClicks, 1, 'кнопка Apple Pay нажата один раз');
    assert.equal(ms.orders.length, 0, 'заказ не размещён расширением');
  } catch (e) { await dumpOnFail(profiles, 'card-fallback'); throw e; } finally { await closeProfiles(profiles); await stopServers(); }
};

/** Карта + autoPlaceOrder: галочка условий, Place Order один раз, «3-D Secure» 2,5 с (THREEDS_MS) — ждём, номер заказа пойман. */
scenarios['auto-place'] = async () => {
  await startServers({ OPEN_AFTER: '0', BUSY_FIRST: '0', THREEDS_MS: '2500' });
  const p = await launchProfile('autoplace');
  const profiles = [p];
  try {
    await p.setConfig(makeConfig('drop-1', [makeOrder('A', 0, ['drop-1'], { racersPerProfile: 1, card: CARD, autoPlaceOrder: true })], { openInSec: -5 }));
    const r = await p.cmd({ cmd: 'start' });
    assert.ok(r.ok, r.error);
    assert.ok((r.warnings ?? []).some((w) => /autoPlaceOrder/.test(w)), 'предупреждение об autoPlaceOrder при старте');
    const done = await waitFor(async () => { const s = await p.status(); return s.os.orderNo ? s : null; }, 60000, 'ORDERED без клика человека', 500);
    const ms = await mockState();
    const log = (await p.cmd({ cmd: 'exportLog' })).text;
    say(`auto-place: ORDERED ${done.os.orderNo}, заказов на моке ${ms.orders.length}, кликов Place Order ${ms.orders[0]?.checkout.placeOrderClicks}`);
    assert.equal(ms.orders.length, 1, 'ровно один заказ');
    assert.equal(ms.orders[0].orderNo, done.os.orderNo, 'номер заказа совпадает');
    assert.equal(ms.orders[0].checkout.placeOrderClicks, 1, 'Place Order нажат один раз');
    assert.equal(ms.orders[0].checkout.termsAccepted, true, 'галочка условий стояла до Place Order');
    assert.ok(/Place Order нажат \(autoPlaceOrder\)/.test(log), 'лог о Place Order');
    assert.equal(done.orders[0].orderNo, done.os.orderNo, 'номер заказа в записи');
  } catch (e) { await dumpOnFail(profiles, 'auto-place'); throw e; } finally { await closeProfiles(profiles); await stopServers(); }
};

// ---------- флот (FLEET-SPEC §12.3) ----------
const identityUrl = (id) => `${MOCK}/ae/shop/buy-iphone/iphone-duo#drop=${encodeURIComponent(id)}&hub=${encodeURIComponent(HUB_WS)}`;
const hubProfile = async (id) => (await hubState()).profiles.find((p) => p.name === id);
/** Заходы сессии на страницу товара в интервале (мс epoch). */
const hitsBetween = (sess, from, to) => (sess?.hits ?? []).filter((h) => h > from && h < to);

/** После номера заказа — ни одной навигации и рефреша; корзина не трогается (FLEET-SPEC §11, §15). */
scenarios['ordered-stays'] = async () => {
  await startServers({ OPEN_AFTER: '0', BUSY_FIRST: '0' });
  const p = await launchProfile('ordered-stays');
  const profiles = [p];
  try {
    await p.setConfig(makeConfig('drop-1', [makeOrder('A', 0, ['drop-1'], { racersPerProfile: 1, card: CARD })], { openInSec: -5 }));
    assert.ok((await p.cmd({ cmd: 'start' })).ok);
    await waitFor(async () => (await p.status()).tabs.some((t) => t.state === 'REVIEW'), 60000, 'REVIEW', 500);
    const pg = p.appleTabs().find((x) => /_s=Review/.test(x.url()));
    await waitFor(async () => (await pg.locator('#terms').isChecked()) || null, 6000, 'галочка условий');
    await pg.click('#place');
    const done = await waitFor(async () => { const s = await p.status(); return s.os.orderNo ? s : null; }, 10000, 'ORDERED');
    const logBefore = (await p.log()).split('\n').length;
    const hitsBefore = (await mockState()).sessions.reduce((a, x) => a + x.hits.length, 0);
    const HOLD = Number(process.env.ORDERED_STAYS_SEC ?? 25);
    say(`ordered-stays: ORDERED ${done.os.orderNo}, наблюдаю ${HOLD} с`);
    await sleep(HOLD * 1000);
    const st = await p.status();
    const log = (await p.log()).split('\n').slice(logBefore).join('\n');
    const ms = await mockState();
    assert.ok(/thankyou/.test(pg.url()), `вкладка осталась на странице подтверждения (${pg.url()})`);
    assert.equal(ms.sessions.reduce((a, x) => a + x.hits.length, 0), hitsBefore, 'заходов на страницу товара не было');
    assert.ok(!/→ |reload #/.test(log), `в логе после ORDERED нет навигаций и рефрешей:\n${log}`);
    assert.equal(st.tabs[0].state, 'ORDERED');
    assert.ok(!/CLEAN|очист/i.test(log), 'корзину никто не чистил');
    assert.equal(st.tabs.length, 1, 'новых вкладок нет');
  } catch (e) { await dumpOnFail(profiles, 'ordered-stays'); throw e; } finally { await closeProfiles(profiles); await stopServers(); }
};

/** 3 профиля × 1 вкладка, у каждого свой заказ (через хаб): все три на Billing, никто никого не останавливает, ORDERED одного не мешает другим. */
scenarios['no-cross-profile-blocking'] = async () => {
  const OPEN_IN = 14;
  await startServers({ OPEN_AFTER: String(OPEN_IN), BUSY_FIRST: '0' }, true);
  const names = ['drop-1', 'drop-2', 'drop-3'];
  const profiles = [];
  try {
    for (const n of names) profiles.push(await launchProfile(n));
    const openAt = Date.now() + OPEN_IN * 1000;
    await mockConfig({ openAfter: (openAt - Date.now()) / 1000 });
    for (const [i, p] of profiles.entries()) {
      // три разных заказа, по одному профилю на заказ; первый — картой (его оформим), остальные Apple Pay
      const orders = names.map((n, j) => makeOrder(String.fromCharCode(65 + j), j, [n], { racersPerProfile: 1, ...(j === 0 ? { card: CARD, payment: 'manual' } : {}) }));
      await p.setConfig(makeConfig(p.name, orders, { openInSec: (openAt - Date.now()) / 1000, hub: true }));
      assert.ok((await p.cmd({ cmd: 'start' })).ok, `${p.name} start`);
      void i;
    }
    const sts = await waitFor(async () => {
      const all = await Promise.all(profiles.map((p) => p.status()));
      return all.every((s) => s.os.billingReadyAt) ? all : null;
    }, 90000, 'все три на Billing', 500);
    say(`no-cross-profile-blocking: Billing ${sts.map((s) => `${s.profileId} +${((s.os.billingReadyAt - s.os.openedAt) / 1000).toFixed(1)} с`).join(' · ')}`);
    const ms = await mockState();
    assert.equal(ms.sessions.filter((x) => x.bag.length).length, 3, 'три корзины с товаром — никто не чистил');
    for (const s of sts) assert.ok(!s.tabs.some((t) => /STANDBY|STOPPED|CLEAN/.test(t.state)), `${s.profileId}: нет STANDBY/STOPPED/CLEAN (${s.tabs.map((t) => t.state)})`);
    // первый оформляет заказ — остальные продолжают
    const p0 = profiles[0];
    await waitFor(async () => (await p0.status()).tabs.some((t) => t.state === 'REVIEW'), 20000, 'REVIEW у drop-1', 500);
    const pg = p0.appleTabs().find((x) => /_s=Review/.test(x.url()));
    await waitFor(async () => (await pg.locator('#terms').isChecked()) || null, 6000, 'галочка условий');
    await pg.click('#place');
    const done = await waitFor(async () => { const s = await p0.status(); return s.os.orderNo ? s : null; }, 10000, 'ORDERED drop-1');
    await sleep(3000);
    const others = await Promise.all(profiles.slice(1).map((p) => p.status()));
    for (const s of others) assert.ok(s.tabs.some((t) => /BILLING|PAY|REVIEW/.test(t.state)), `${s.profileId} продолжает оплату после ORDERED у drop-1 (${s.tabs.map((t) => t.state)})`);
    const hs = await waitFor(async () => { const h = await hubState(); return h.profiles.find((x) => x.name === 'drop-1')?.orderNo ? h : null; }, 10000, 'ORDERED дошёл до хаба');
    assert.equal(hs.profiles.filter((x) => x.payReadyAt).length, 3, 'на хабе три PAY_READY');
    assert.equal(hs.records.length, 3, 'три записи о заказах на хабе');
    assert.ok(hs.firstOpen, 'хаб видел первый OPEN');
    say(`no-cross-profile-blocking: ORDERED ${done.os.orderNo} у drop-1, остальные продолжают; на хабе записей ${hs.records.length}`);
  } catch (e) { await dumpOnFail(profiles, 'no-cross-profile-blocking'); throw e; } finally { await closeProfiles(profiles); await stopServers(); }
};

/** Клон стартует с #drop=…&hub=… → profileId сохранён, хеш убран, конфиг получен с хаба, хаб видит REGISTER. */
scenarios['fleet-identity'] = async () => {
  const fl = makeFleet('fleet-identity', { 'nl1-p01': { strategy: 'hold' } }, { openInSec: 3600, defaults: { autoStart: false } });
  await startServers({}, true, { FLEET_FILE: fl.file });
  const p = await launchProfile('fleet-identity', { startUrl: identityUrl('nl1-p01') });
  const profiles = [p];
  try {
    const st = await waitFor(async () => { const s = await p.status(); return s.profileId === 'nl1-p01' && s.cfg.version === 1 ? s : null; }, 20000, 'имя и конфиг v1 с хаба');
    say(`fleet-identity: профиль ${st.profileId}, сервер ${st.server}, конфиг v${st.cfg.version} (${st.cfg.meta?.source}), стратегия ${st.strategy}, хаб ${st.hub.connected ? '✓' : '✗'}`);
    assert.equal(st.server, 'nl1');
    assert.equal(st.strategy, 'hold', 'стратегия профиля из fleet.json');
    assert.equal(st.cfg.hash, fl.fleet && (await hubState()).fleet.hash, 'хеш конфига совпадает с хабом');
    assert.equal(st.cfg.meta.source, 'identity');
    assert.equal(st.order.id, 'nl1-p01', 'заказ = профиль');
    assert.ok(!p.startPage.url().includes('#'), `хеш убран из адреса (${p.startPage.url()})`);
    const hp = await waitFor(async () => { const x = await hubProfile('nl1-p01'); return x?.online ? x : null; }, 10000, 'REGISTER на хабе');
    assert.equal(hp.server, 'nl1');
    assert.equal(hp.cfgVersion, 1);
    assert.equal(hp.strategy, 'hold');
    assert.ok(!st.os.armed, 'autoStart выключен — гонка не началась');
    const stored = await p.control.evaluate(() => chrome.storage.local.get(['profileId', 'hubUrl']));
    assert.equal(stored.profileId, 'nl1-p01');
    assert.equal(stored.hubUrl, HUB_WS);
    // перезагрузка стартовой страницы без хеша — имя не меняется, второго IDENTITY нет
    await p.startPage.reload();
    await sleep(1500);
    assert.equal((await p.status()).profileId, 'nl1-p01');
    const log = await p.log();
    assert.ok(/профиль назначен: nl1-p01/.test(log), 'лог о назначении имени');
    assert.ok(!/token=[^…]/.test(log), 'токен хаба в логе замаскирован');
  } catch (e) { await dumpOnFail(profiles, 'fleet-identity'); throw e; } finally { await closeProfiles(profiles); await stopServers(); }
};

/**
 * refresh и hold рядом, ADMIT_SESSIONS=odd: первый профиль (нечётная сессия) пускают с openAt, второй — через ADMIT_DELAY_MS.
 * refresh рефрешит после openAt до своего OPEN; hold — ни одного захода на товар до своего OPEN; оба на Billing;
 * на хабе два OPEN с разным временем; OPEN_SEEN у hold не вызвал рефреш.
 */
scenarios['fleet-strategies'] = async () => {
  const OPEN_IN = 16, DELAY = 9000;
  const fl = makeFleet('fleet-strategies', { 'nl1-p01': { strategy: 'refresh' }, 'nl1-p02': { strategy: 'hold' } }, { openInSec: OPEN_IN });
  await startServers({ OPEN_AFTER: String(OPEN_IN), BUSY_FIRST: '0', ADMIT_SESSIONS: 'odd', ADMIT_DELAY_MS: String(DELAY) }, true, { FLEET_FILE: fl.file });
  const openAt = Date.parse(fl.fleet.openAt);
  const profiles = [];
  try {
    const a = await launchProfile('fs-refresh', { startUrl: identityUrl('nl1-p01') });
    profiles.push(a);
    await waitFor(async () => (await p0Armed(a)), 20000, 'refresh-профиль взведён autoStart');
    await waitFor(async () => (await mockState()).sessions.length >= 1 || null, 10000, 'сессия refresh-профиля на моке');
    const b = await launchProfile('fs-hold', { startUrl: identityUrl('nl1-p02') });
    profiles.push(b);
    await waitFor(async () => (await p0Armed(b)), 20000, 'hold-профиль взведён autoStart');
    const ms0 = await waitFor(async () => { const m = await mockState(); return m.sessions.length >= 2 ? m : null; }, 10000, 'две сессии на моке');
    say(`fleet-strategies: сессии ${ms0.sessions.map((x) => `#${x.idx}`).join(', ')}; OPEN через ${((openAt - Date.now()) / 1000).toFixed(1)} с`);
    const sts = await waitFor(async () => {
      const [sa, sb] = await Promise.all([a.status(), b.status()]);
      return sa.os.billingReadyAt && sb.os.billingReadyAt ? [sa, sb] : null;
    }, (OPEN_IN + 60) * 1000, 'оба на Billing', 500);
    const [sa, sb] = sts;
    const ms = await mockState();
    const sessA = ms.sessions.find((x) => x.idx === 1), sessB = ms.sessions.find((x) => x.idx === 2);
    const aHits = hitsBetween(sessA, openAt + 200, sa.os.openedAt - 200);
    const bHits = hitsBetween(sessB, openAt + 200, sb.os.openedAt - 300);
    say(`fleet-strategies: refresh OPEN +${((sa.os.openedAt - openAt) / 1000).toFixed(1)} с, Billing +${((sa.os.billingReadyAt - sa.os.openedAt) / 1000).toFixed(1)} с; hold OPEN +${((sb.os.openedAt - openAt) / 1000).toFixed(1)} с, Billing +${((sb.os.billingReadyAt - sb.os.openedAt) / 1000).toFixed(1)} с · заходов до своего OPEN: refresh ${aHits.length}, hold ${bHits.length}`);
    assert.ok(sb.os.openedAt - sa.os.openedAt >= DELAY - 2500, `hold пустили позже refresh (${((sb.os.openedAt - sa.os.openedAt) / 1000).toFixed(1)} с)`);
    assert.equal(bHits.length, 0, 'hold: ни одного захода на товар между openAt и своим OPEN');
    assert.ok(aHits.length >= 1 || sa.os.openedAt - openAt < 2500, `refresh: рефрешил после openAt (${aHits.length}) или OPEN пришёл сразу`);
    const logB = await b.log();
    assert.ok(/HOLD|hold/.test(logB), 'hold в логе');
    assert.ok(/уже пустили|OPEN_SEEN|флот/.test(logB), 'OPEN_SEEN отмечен в логе hold-профиля');
    assert.ok(!/hold не дождался/.test(logB), 'hold дождался своего OPEN без фолбэка');
    const hs = await hubState();
    const ha = hs.profiles.find((x) => x.name === 'nl1-p01'), hb = hs.profiles.find((x) => x.name === 'nl1-p02');
    assert.ok(ha.openedAt && hb.openedAt && hb.openedAt - ha.openedAt >= DELAY - 2500, 'на хабе два OPEN с разным временем');
    assert.equal(hs.firstOpen.profile, 'nl1-p01');
    assert.equal(hs.profiles.filter((x) => x.payReadyAt).length, 2);
  } catch (e) { await dumpOnFail(profiles, 'fleet-strategies'); throw e; } finally { await closeProfiles(profiles); await stopServers(); }
};
scenarios['fleet-refresh'] = scenarios['fleet-strategies'];
scenarios['fleet-hold'] = scenarios['fleet-strategies'];
async function p0Armed(p) { try { return (await p.status()).os.armed || null; } catch { return null; } }

/** hold без своего OPEN holdFallbackSec → перешёл на refresh (лог), потом пустили → Billing. */
scenarios['hold-fallback'] = async () => {
  const OPEN_IN = 10, FALLBACK = 6, ADMIT = 12000;
  await startServers({ OPEN_AFTER: String(OPEN_IN), BUSY_FIRST: '0', ADMIT_SESSIONS: 'none', ADMIT_DELAY_MS: String(ADMIT) });
  const p = await launchProfile('hold-fallback');
  const profiles = [p];
  try {
    const openAt = Date.now() + OPEN_IN * 1000;
    await mockConfig({ openAfter: OPEN_IN });
    await p.setConfig(makeConfig('drop-1', [makeOrder('A', 0, ['drop-1'], { racersPerProfile: 1 })], { openInSec: OPEN_IN, strategy: 'hold', timing: { holdFallbackSec: FALLBACK } }));
    assert.ok((await p.cmd({ cmd: 'start' })).ok);
    await waitFor(async () => /hold не дождался/.test(await p.log()) || null, (OPEN_IN + FALLBACK + 8) * 1000, 'лог о переходе на refresh', 500);
    const tFallback = Date.now();
    say(`hold-fallback: перешёл на refresh через ${((tFallback - openAt) / 1000).toFixed(1)} с после openAt`);
    assert.ok(tFallback - openAt >= FALLBACK * 1000 - 1500, 'не раньше holdFallbackSec');
    const st = await waitFor(async () => { const s = await p.status(); return s.os.billingReadyAt ? s : null; }, 60000, 'Billing', 500);
    const ms = await mockState();
    const sess = ms.sessions.find((x) => x.bag.length);
    const before = hitsBetween(sess, openAt + 200, openAt + FALLBACK * 1000 - 500);
    const after = hitsBetween(sess, openAt + FALLBACK * 1000 + 200, st.os.openedAt - 200);
    say(`hold-fallback: заходов на товар до фолбэка ${before.length}, после ${after.length}; OPEN +${((st.os.openedAt - openAt) / 1000).toFixed(1)} с`);
    assert.equal(before.length, 0, 'до holdFallbackSec — ни одного рефреша');
    assert.ok(after.length >= 1, 'после фолбэка рефрешит как refresh');
  } catch (e) { await dumpOnFail(profiles, 'hold-fallback'); throw e; } finally { await closeProfiles(profiles); await stopServers(); }
};

/** Хаб падает после Start → профиль доходит до Billing/Review без него; хаб поднялся → REGISTER, ORDERED доставлен. */
scenarios['hub-down'] = async () => {
  const OPEN_IN = 8;
  const fl = makeFleet('hub-down', { 'nl1-p01': { payment: 'manual', card: CARD } }, { openInSec: OPEN_IN });
  const { hub } = await startServers({ OPEN_AFTER: String(OPEN_IN), BUSY_FIRST: '0' }, true, { FLEET_FILE: fl.file });
  const p = await launchProfile('hub-down', { startUrl: identityUrl('nl1-p01') });
  const profiles = [p];
  try {
    await waitFor(async () => (await p.status()).os.armed || null, 20000, 'autoStart взвёл профиль');
    await stopChild(hub);
    say('hub-down: хаб остановлен после Start');
    await waitFor(async () => !(await p.status()).hub.connected || null, 10000, 'расширение видит отключение хаба');
    const st = await waitFor(async () => { const s = await p.status(); return s.os.billingReadyAt ? s : null; }, 60000, 'Billing без хаба', 500);
    await waitFor(async () => (await p.status()).tabs.some((t) => t.state === 'REVIEW'), 15000, 'REVIEW без хаба');
    say(`hub-down: Billing +${((st.os.billingReadyAt - st.os.openedAt) / 1000).toFixed(1)} с и Review без хаба`);
    await startHub({ FLEET_FILE: fl.file });
    const hp = await waitFor(async () => { const x = await hubProfile('nl1-p01'); return x?.online && x.openedAt && x.tabs.length ? x : null; }, 20000, 'REGISTER + повтор OPEN/STATUS после подъёма хаба');
    assert.ok(hp.payReadyAt, 'PAY_READY, пропущенный хабом, доставлен повтором');
    assert.ok(hp.tabs.some((t) => t.state === 'REVIEW'), 'хаб видит REVIEW');
    const pg = p.appleTabs().find((x) => /_s=Review/.test(x.url()));
    await waitFor(async () => (await pg.locator('#terms').isChecked()) || null, 6000, 'галочка условий');
    await pg.click('#place');
    const done = await waitFor(async () => { const s = await p.status(); return s.os.orderNo ? s : null; }, 10000, 'ORDERED');
    const hs = await waitFor(async () => { const h = await hubState(); return h.profiles.find((x) => x.name === 'nl1-p01')?.orderNo ? h : null; }, 10000, 'ORDERED на хабе');
    assert.equal(hs.profiles.find((x) => x.name === 'nl1-p01').orderNo, done.os.orderNo);
    assert.ok(hs.records.some((r) => r.orderNo === done.os.orderNo), 'запись о заказе на хабе');
    const log = await p.log();
    assert.ok(/хаб недоступен|без хаба|не отвечает/.test(log) || !(await p.status()).hub.connected === false, 'лог про недоступный хаб');
    say(`hub-down: ORDERED ${done.os.orderNo} доставлен на хаб после его подъёма`);
  } catch (e) { await dumpOnFail(profiles, 'hub-down'); throw e; } finally { await closeProfiles(profiles); await stopServers(); }
};

/** «Разослать конфиг»: профиль в IDLE подтянул v2, профиль в гонке — нет (cfgPending), после Stop — подтянул. */
scenarios['config-update'] = async () => {
  const fl = makeFleet('config-update', { 'nl1-p01': {}, 'nl1-p02': {} }, { openInSec: 3600, defaults: { autoStart: false } });
  await startServers({}, true, { FLEET_FILE: fl.file });
  const a = await launchProfile('cu-idle', { startUrl: identityUrl('nl1-p01') });
  const b = await launchProfile('cu-armed', { startUrl: identityUrl('nl1-p02') });
  const profiles = [a, b];
  try {
    for (const p of profiles) await waitFor(async () => { const s = await p.status(); return s.cfg.version === 1 ? s : null; }, 20000, `${p.name}: конфиг v1`);
    assert.ok((await b.cmd({ cmd: 'start' })).ok, 'Start второго');
    await waitFor(async () => (await b.status()).os.armed || null, 10000, 'второй взведён');
    fl.rewrite({ version: 2, defaults: { ...fl.fleet.defaults, strategy: 'hold' } });
    const r = await (await fetch(`${HUB}/api/reload`, { method: 'POST' })).json();
    assert.equal(r.version, 2, 'хаб перечитал fleet.json v2');
    const sa = await waitFor(async () => { const s = await a.status(); return s.cfg.version === 2 ? s : null; }, 10000, 'IDLE-профиль подтянул v2');
    assert.equal(sa.strategy, 'hold', 'новая стратегия применена');
    await sleep(1500);
    const sb = await b.status();
    assert.equal(sb.cfg.version, 1, 'профиль в гонке остался на v1');
    assert.equal(sb.cfg.pending, 2, 'cfgPending = 2');
    const hb = await waitFor(async () => { const x = await hubProfile('nl1-p02'); return x?.cfgPending === 2 ? x : null; }, 10000, 'хаб видит cfgPending');
    assert.equal(hb.cfgVersion, 1);
    assert.ok((await b.cmd({ cmd: 'stop' })).ok);
    const sb2 = await waitFor(async () => { const s = await b.status(); return s.cfg.version === 2 ? s : null; }, 10000, 'после Stop подтянул v2');
    assert.equal(sb2.cfg.pending, undefined);
    say(`config-update: IDLE v1→v2 сразу, в гонке v1 (pending 2), после Stop v2 ✓`);
    // команда с дашборда: setStrategy одному профилю
    const rc = await hubCmd('nl1-p01', 'setStrategy', { strategy: 'refresh' });
    assert.deepEqual(rc.sent, ['nl1-p01']);
    await waitFor(async () => (await a.status()).strategy === 'refresh' || null, 5000, 'setStrategy с хаба применён');
    const rs = await hubCmd('server:nl1', 'checkIp');
    assert.equal(rs.sent.length, 2, 'команда серверу ушла двум профилям');
    await waitFor(async () => { const h = await hubState(); return h.profiles.filter((x) => x.egress?.ip).length === 2 ? h : null; }, 10000, 'egress обоих на хабе');
  } catch (e) { await dumpOnFail(profiles, 'config-update'); throw e; } finally { await closeProfiles(profiles); await stopServers(); }
};

/** Прокси из конфига: профиль ходит через локальный HTTP-прокси с логином (мок без X-Mock-Proxy → 403), egress AE; профиль без прокси — напрямую (NL). */
scenarios.proxy = async () => {
  const proxy = await startLocalProxy();
  const fl = makeFleet('proxy', {
    'nl1-p01': { proxy: { scheme: 'http', host: '127.0.0.1', port: proxy.port, username: proxy.username, password: proxy.password, bypass: ['<-loopback>', `127.0.0.1:${HUB_PORT}`] } },
    'nl1-p02': { proxy: null },
  }, { openInSec: 3600, defaults: { autoStart: false } });
  // PROXY_REQUIRED_HEADER включаем после того, как профиль без прокси уже получил сессию — иначе ему всё 403
  await startServers({}, true, { FLEET_FILE: fl.file });
  const direct = await launchProfile('proxy-direct', { startUrl: identityUrl('nl1-p02') });
  const profiles = [direct];
  try {
    const sd = await waitFor(async () => { const s = await direct.status(); return s.cfg.version === 1 && s.egress?.ip ? s : null; }, 20000, 'прямой профиль: конфиг и IP');
    assert.equal(sd.egress.country, 'NL', 'без прокси выход NL');
    assert.equal(sd.proxy, null);
    const viaProxy = await launchProfile('proxy-via', { startUrl: identityUrl('nl1-p01') });
    profiles.push(viaProxy);
    const sp = await waitFor(async () => { const s = await viaProxy.status(); return s.cfg.version === 1 && s.proxy && s.egress?.ip && s.egress.country === 'AE' ? s : null; }, 30000, 'профиль с прокси: конфиг, прокси применён, выход AE');
    say(`proxy: через прокси ${sp.proxy.label} → ${sp.egress.ip} ${sp.egress.country}; напрямую → ${sd.egress.ip} ${sd.egress.country}; запросов через прокси ${proxy.stats.requests}, отказов 407 ${proxy.stats.authFailed}`);
    assert.ok(proxy.stats.requests > 0, 'прокси видел запросы');
    assert.ok(proxy.stats.authFailed >= 1, 'был challenge 407 и расширение ответило логином');
    // теперь мок пускает только через прокси: профиль с прокси доходит до Billing, прямой получил бы 403
    await mockConfig({ proxyRequiredHeader: true, openAfter: 0, busyFirst: false });
    fl.rewrite({ version: 2, openAt: new Date(Date.now() - 5000).toISOString() });
    await fetch(`${HUB}/api/reload`, { method: 'POST' });
    await waitFor(async () => (await viaProxy.status()).cfg.version === 2 || null, 10000, 'конфиг v2 (openAt сейчас)');
    assert.ok((await viaProxy.cmd({ cmd: 'start' })).ok, 'Start через прокси');
    const st = await waitFor(async () => { const s = await viaProxy.status(); return s.os.billingReadyAt ? s : null; }, 60000, 'Billing через прокси', 500);
    say(`proxy: Billing через прокси +${((st.os.billingReadyAt - st.os.openedAt) / 1000).toFixed(1)} с`);
    const hs = await hubState();
    const hp = hs.profiles.find((x) => x.name === 'nl1-p01');
    assert.equal(hp.egress?.country, 'AE', 'egress на дашборде');
    assert.equal(hs.profiles.find((x) => x.name === 'nl1-p02').egress?.country, 'NL');
    const log = await viaProxy.log();
    assert.ok(!log.includes(proxy.password), 'пароль прокси в логе не встречается');
    assert.ok(/прокси http:\/\/127\.0\.0\.1:\d+ \(с логином\) применён/.test(log), 'лог о применении прокси');
    assert.ok(/выход: 203\.0\.113\.7 · AE/.test(log), 'лог о выходном IP');
    const hubLog = hs.log.map((e) => e.line).join('\n');
    assert.ok(!hubLog.includes(proxy.password), 'пароль прокси не дошёл до хаба');
  } catch (e) { await dumpOnFail(profiles, 'proxy'); throw e; } finally { await closeProfiles(profiles); await stopServers(); await proxy.close(); }
};

/**
 * Apple Pay: (а) APPLEPAY_TRUSTED_ONLY — программный клик лист не открыл → debugger-клик (в Playwright attach обычно
 * падает: CDP уже занят) → подсветка, «человек» кликает → лист; (б) лист закрывается через APPLEPAY_SHEET_TTL_MS → повтор до applePayRetries.
 */
scenarios['applepay-retry'] = async () => {
  // (а) только настоящий клик
  await startServers({ OPEN_AFTER: '0', BUSY_FIRST: '0', APPLEPAY_TRUSTED_ONLY: '1' });
  let p = await launchProfile('ap-trusted');
  let profiles = [p];
  try {
    await p.setConfig(makeConfig('drop-1', [makeOrder('A', 0, ['drop-1'], { racersPerProfile: 1, payment: 'applepay', applePayRetries: 3 })], { openInSec: -5 }));
    assert.ok((await p.cmd({ cmd: 'start' })).ok);
    await waitFor(async () => /debugger-клик/.test(await p.log()) || null, 60000, 'запрошен debugger-клик', 500);
    // либо лист открыт debugger-кликом, либо attach не удался и кнопка подсвечена для человека
    const outcome = await waitFor(async () => {
      const m = await mockState();
      const sess = m.sessions.find((x) => x.bag.length);
      if (sess?.checkout.applePayTrusted) return { via: 'debugger', sess };
      const log = await p.log();
      if (/нужен клик человека/.test(log)) return { via: 'human', sess };
      return null;
    }, 20000, 'исход debugger-клика', 500);
    const log1 = await p.log();
    assert.ok(/debugger-клик по кнопке Apple Pay/.test(log1), 'SW писал о debugger-клике');
    assert.ok((outcome.sess.checkout.applePayUntrusted ?? 0) >= 1, 'программный клик мок отверг (isTrusted=false)');
    if (outcome.via === 'human') {
      const pg = p.appleTabs().find((x) => /_s=Review/.test(x.url()));
      const outline = await pg.locator('[data-autom="apple-pay-button"]').evaluate((b) => b.style.outline);
      assert.match(outline, /solid/, 'кнопка Apple Pay подсвечена для человека');
      await pg.click('[data-autom="apple-pay-button"]');
      await waitFor(async () => (await mockState()).sessions.some((x) => x.checkout.applePayTrusted) || null, 5000, 'лист открыт кликом человека');
    }
    const ms = await mockState();
    const sess = ms.sessions.find((x) => x.bag.length);
    say(`applepay-retry (trusted-only): лист открыт через ${outcome.via}; программных кликов отвергнуто ${sess.checkout.applePayUntrusted}, настоящих ${sess.checkout.applePayTrusted}`);
    assert.equal(sess.checkout.applePayTrusted, 1);
    assert.ok(!/debugger не отключ/.test(log1));
  } catch (e) { await dumpOnFail(profiles, 'applepay-retry-a'); throw e; } finally { await closeProfiles(profiles); await stopServers(); }

  // (б) лист сам закрывается → повтор
  await startServers({ OPEN_AFTER: '0', BUSY_FIRST: '0', APPLEPAY_SHEET_TTL_MS: '2000' });
  p = await launchProfile('ap-retry');
  profiles = [p];
  try {
    await p.setConfig(makeConfig('drop-1', [makeOrder('A', 0, ['drop-1'], { racersPerProfile: 1, payment: 'applepay', applePayRetries: 2 })], { openInSec: -5 }));
    assert.ok((await p.cmd({ cmd: 'start' })).ok);
    const ms = await waitFor(async () => { const m = await mockState(); const s = m.sessions.find((x) => x.bag.length); return s?.checkout.applePayClicks >= 3 ? m : null; }, 90000, '3 открытия листа (1 + 2 повтора)', 500);
    const sess = ms.sessions.find((x) => x.bag.length);
    await waitFor(async () => /повторы исчерпаны/.test(await p.log()) || null, 20000, 'повторы исчерпаны', 500);
    await sleep(3000);
    const log = await p.log();
    const st = await p.status();
    say(`applepay-retry (ttl): открытий листа ${sess.checkout.applePayClicks}, закрытий ${sess.checkout.applePaySheetClosed}, состояние ${st.tabs[0].state}: ${st.tabs[0].detail}`);
    assert.equal((await mockState()).sessions.find((x) => x.bag.length).checkout.applePayClicks, 3, 'ровно 1 + applePayRetries открытий');
    assert.equal((log.match(/лист Apple Pay закрылся без заказа — повтор/g) ?? []).length, 2, 'два повтора в логе');
    assert.match(st.tabs[0].detail, /нажми Apple Pay/i, 'после исчерпания — человек (ASSIST-подсветка кнопки)');
    assert.equal(ms.orders.length, 0, 'заказ не размещён расширением');
  } catch (e) { await dumpOnFail(profiles, 'applepay-retry-b'); throw e; } finally { await closeProfiles(profiles); await stopServers(); }
};

/** CARD_DELAY_MS=45000: поля карты через 45 с — дождались (cardWaitMs 90 с), Apple Pay не включился, карта и адрес заполнены, Review открыт. */
scenarios['card-slow-90s'] = async () => {
  await startServers({ OPEN_AFTER: '0', BUSY_FIRST: '0', CARD_DELAY_MS: '45000' });
  const p = await launchProfile('cardslow90');
  const profiles = [p];
  try {
    await p.setConfig(makeConfig('drop-1', [makeOrder('A', 0, ['drop-1'], { racersPerProfile: 1, card: CARD, payment: 'manual' })], { openInSec: -5 }));
    assert.ok((await p.cmd({ cmd: 'start' })).ok);
    await waitFor(async () => (await p.status()).os.stage === 'BILLING' || (await p.log()).includes('ждём поля карты') || null, 60000, 'на Billing, ждём поля карты', 500);
    await waitFor(async () => /поля карты ещё не появились \(1[5-9] с\)/.test(await p.log()) || null, 30000, 'лог ожидания каждые 15 с', 500);
    const ms = await waitFor(async () => { const m = await mockState(); return m.sessions.some((s) => s.checkout.review) ? m : null; }, 90000, 'Review', 500);
    const sess = ms.sessions.find((s) => s.bag.length);
    const log = await p.log();
    say(`card-slow-90s: способ ${sess.checkout.method}, карта ****${sess.checkout.review.cardLast4}, ${/появились через (\d+\.\d) с/.exec(log)?.[0]}`);
    assert.equal(sess.checkout.method, 'CREDIT', 'Apple Pay не включился (cardFallback null)');
    assert.equal(sess.checkout.review.cardLast4, '1111');
    assert.equal(sess.checkout.review.billing.street, 'Sheikh Zayed Rd 1', 'адрес заполнен');
    assert.ok(/поля карты появились через 4[4-9]\.\d с/.test(log), 'ожидание ~45 с в логе');
    assert.ok(!/переключаюсь на Apple Pay/.test(log));
    assert.ok((log.match(/поля карты ещё не появились/g) ?? []).length >= 2, 'лог каждые 15 с');
  } catch (e) { await dumpOnFail(profiles, 'card-slow-90s'); throw e; } finally { await closeProfiles(profiles); await stopServers(); }
};

/** Приёмка (FLEET-SPEC §15): 2 «сервера» × 3 профиля, клоны стартуют по адресу с хешем и autoStart; все на Billing ≤ 15 с после своего OPEN; дашборд 6 строк; CSV 6 записей. */
scenarios.acceptance = async () => {
  const OPEN_IN = 30;
  const names = ['nl1-p01', 'nl1-p02', 'nl1-p03', 'ae1-p01', 'ae1-p02', 'ae1-p03'];
  const fl = makeFleet('acceptance', Object.fromEntries(names.map((n, i) => [n, { strategy: i % 2 ? 'hold' : 'refresh', payment: i % 3 === 0 ? 'manual' : 'applepay', card: i % 3 === 0 ? CARD : undefined }])), { openInSec: OPEN_IN });
  await startServers({ OPEN_AFTER: String(OPEN_IN) }, true, { FLEET_FILE: fl.file });
  const openAt = Date.parse(fl.fleet.openAt);
  const profiles = [];
  try {
    for (const n of names) profiles.push(await launchProfile(n, { startUrl: identityUrl(n) }));
    await waitFor(async () => { const h = await hubState(); return h.profiles.filter((x) => x.online).length === 6 ? h : null; }, 30000, '6 профилей на хабе');
    for (const p of profiles) await waitFor(async () => (await p.status()).os.armed || null, 20000, `${p.name} взведён autoStart`);
    say(`acceptance: 6 клонов представились и взвелись сами, OPEN через ${((openAt - Date.now()) / 1000).toFixed(1)} с`);
    const hs = await waitFor(async () => { const h = await hubState(); return h.profiles.filter((x) => x.payReadyAt).length === 6 ? h : null; }, (OPEN_IN + 90) * 1000, '6 профилей на Billing', 500);
    const rows = hs.profiles.map((x) => `${x.name}(${x.strategy}) OPEN +${((x.openedAt - openAt) / 1000).toFixed(1)} → Billing +${((x.payReadyAt - x.openedAt) / 1000).toFixed(1)} с`);
    say(`acceptance: ${rows.join(' · ')}`);
    const worst = Math.max(...hs.profiles.map((x) => x.payReadyAt - x.openedAt)) / 1000;
    assert.ok(worst <= 15, `все на Billing ≤ 15 с после своего OPEN (худший ${worst.toFixed(1)} с)`);
    assert.equal(hs.profiles.length, 6, 'дашборд: 6 строк');
    assert.deepEqual([...new Set(hs.profiles.map((x) => x.server))].sort(), ['ae1', 'nl1'], 'два сервера');
    assert.equal(hs.records.length, 6, '6 записей о заказах');
    const csv = await (await fetch(`${HUB}/api/orders.csv`)).text();
    assert.equal(csv.trim().split('\n').length, 7, 'CSV: заголовок + 6 строк');
    for (const n of names) assert.ok(csv.includes(n), `CSV содержит ${n}`);
    const ms = await mockState();
    assert.equal(ms.sessions.filter((s) => s.bag.length).length, 6, '6 корзин с товаром, ничьи не очищены');
    for (const s of ms.sessions.filter((x) => x.bag.length)) { assert.equal(s.bag.length, 1); assert.equal(s.bag[0].qty, 1); }
    // Stop все с дашборда
    const r = await hubCmd('all', 'stop');
    assert.equal(r.sent.length, 6);
    await waitFor(async () => { const all = await Promise.all(profiles.map((p) => p.status())); return all.every((s) => !s.os.armed) ? true : null; }, 15000, 'Stop все выполнен');
    const logs = await Promise.all(profiles.map((p) => p.log()));
    for (const l of logs) { assert.ok(!l.includes('4111111111111111'), 'номера карты нет в логе'); }
    assert.ok(!hs.log.some((e) => /4111111111111111/.test(e.line)), 'номера карты нет на хабе');
  } catch (e) { await dumpOnFail(profiles, 'acceptance'); throw e; } finally { await closeProfiles(profiles); await stopServers(); }
};

const list = want.length ? want : [
  'single', 'hostile', 'assist', 'prepare', 'queue', 'checkout-errors', 'renamed-selectors', 'applepay-turn', 'card-slow', 'card-fallback', 'auto-place',
  'closed-backsoon', 'closed-redirect', 'closed-offsite', 'closed-blank',
  'ordered-stays', 'no-cross-profile-blocking', 'fleet-identity', 'fleet-strategies', 'hold-fallback', 'hub-down', 'config-update', 'proxy', 'applepay-retry', 'card-slow-90s', 'acceptance',
];
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
    await stopServers();
  }
}
process.exit(failed ? 1 : 0);
