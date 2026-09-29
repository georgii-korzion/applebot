// E2E на мок-сервере (§11.1, §11.3). Playwright здесь — только тестовый стенд, чтобы запускать
// обычные профили Chromium с dev-сборкой расширения; само расширение CDP не использует.
//   npm run test:e2e                 — все сценарии
//   node test/e2e.mjs single assist  — выбранные
// CHROME_PATH — путь к Chromium/Chrome (по умолчанию ищется в PLAYWRIGHT_BROWSERS_PATH).
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(root, 'dist-dev');
const MOCK = 'http://127.0.0.1:4777';
const HUB_PORT = 18765;
const HUB = `http://127.0.0.1:${HUB_PORT}`;
const ART = join(root, 'test/.artifacts');
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

async function startServers(mockEnv = {}, withHub = false) {
  const mock = run('test/mock-server.mjs', { OPEN_AFTER: '3600', ...mockEnv });
  await waitHttp(`${MOCK}/__state`);
  let hub = null;
  if (withHub) {
    hub = run('hub/server.mjs', { HUB_PORT: String(HUB_PORT) });
    await waitHttp(`${HUB}/api/state`);
  }
  return { mock, hub };
}
async function stopServers() {
  for (const ch of children.splice(0)) { ch.kill(); await new Promise((r) => ch.once('exit', r)); }
}

// ---------- профили ----------
async function launchProfile(name) {
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
  prof.appleTabs = () => ctx.pages().filter((p) => p.url().startsWith(MOCK));
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
function makeConfig(profileId, orders, { openInSec, hub = false, mode = 'auto', timing = {} } = {}) {
  return {
    profileId, hubUrl: hub ? `ws://127.0.0.1:${HUB_PORT}` : '',
    openAt: new Date(Date.now() + openInSec * 1000).toISOString(),
    mode, orders,
    timing: { pollMs: 1200, preOpenReloadMs: 3000, postOpenReloadMs: 1500, minReloadMs: 1500, jitterPct: 30, graceSec: 20, atbTimeoutMs: 15000, atb404BackoffMs: 1500, atb404MaxInRow: 5, holdLoserBagSec: 90, manualPayTimeoutSec: 600, assistAfterFailures: 3, ...timing },
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
      const log = await p.cmd({ cmd: 'exportLog' });
      writeFileSync(join(ART, `${name}-${p.name}.log`), log?.text ?? '');
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

/** Приёмка: 3 заказа × 2 профиля × 2 вкладки + хаб → 3 заказа на Billing ≤ 10 с после OPEN, без дублей. */
scenarios.acceptance = async () => {
  const OPEN_IN = 12;
  await startServers({ OPEN_AFTER: String(OPEN_IN) }, true);
  const names = ['drop-1', 'drop-2', 'drop-3', 'drop-4', 'drop-5', 'drop-6'];
  const orders = [makeOrder('A', 0, ['drop-1', 'drop-2']), makeOrder('B', 1, ['drop-3', 'drop-4']), makeOrder('C', 2, ['drop-5', 'drop-6'])];
  const profiles = [];
  try {
    for (const n of names) profiles.push(await launchProfile(n));
    const openAt = Date.now() + OPEN_IN * 1000;
    await fetch(`${MOCK}/__config`, { method: 'POST', body: JSON.stringify({ openAfter: (openAt - Date.now()) / 1000 }) });
    for (const p of profiles) {
      const cfg = makeConfig(p.name, orders, { openInSec: (openAt - Date.now()) / 1000, hub: true });
      await p.setConfig(cfg);
    }
    await waitFor(async () => (await hubState()).profiles.filter((x) => x.online).length === 6, 15000, '6 профилей в хабе');
    for (const p of profiles) { const r = await p.cmd({ cmd: 'start' }); assert.ok(r.ok, `${p.name} start: ${r.error}`); }
    say('acceptance: 6 профилей × 2 вкладки взведены, OPEN через', ((openAt - Date.now()) / 1000).toFixed(1), 'с');
    const hs = await waitFor(async () => {
      const h = await hubState();
      return h.orders.length === 3 && h.orders.every((o) => o.billingAt) ? h : null;
    }, 90000, '3 заказа на Billing', 500);
    const times = hs.orders.map((o) => `${o.id}: +${((o.billingAt - hs.openedAt) / 1000).toFixed(1)} с (${o.winner})`);
    say('acceptance: Billing', times.join(' · '));
    const worst = Math.max(...hs.orders.map((o) => o.billingAt - hs.openedAt)) / 1000;
    // проигравшие чистят корзины
    await waitFor(async () => {
      const ms = await mockState();
      const withBag = ms.sessions.filter((s) => s.bag.length);
      return withBag.length === 3 ? ms : null;
    }, 20000, 'корзины проигравших очищены');
    const ms = await mockState();
    for (const s of ms.sessions.filter((x) => x.bag.length)) {
      assert.equal(s.bag.length, 1, 'одна позиция');
      assert.equal(s.bag[0].qty, 1, 'количество 1');
      assert.ok(s.checkout.fulfillment?.store, 'самовывоз выбран');
    }
    // очередь оплаты: впереди ровно один
    assert.ok(hs.active, 'кто-то на оплате');
    const active = hs.active.orderId;
    say(`acceptance: на оплате ${active} (${hs.active.profile}), ждут ${hs.queue.map((q) => q.orderId).join(',')}`);
    const waiting = hs.queue.map((q) => q.priority);
    assert.deepEqual(waiting, [...waiting].sort((a, b) => a - b), 'ждущие упорядочены по priority');
    assert.equal(hs.queue.length, 2, 'остальные два ждут');
    await fetch(`${HUB}/api/next`, { method: 'POST' });
    const h2 = await waitFor(async () => { const h = await hubState(); return h.active && h.active.orderId !== active ? h : null; }, 5000, 'следующий на оплату');
    say(`acceptance: «Следующий» → ${h2.active.orderId}`);
    assert.ok(worst <= 10, `все 3 заказа на Billing ≤ 10 с после OPEN (худший ${worst.toFixed(1)} с)`);
  } catch (e) { await dumpOnFail(profiles, 'acceptance'); throw e; } finally { await closeProfiles(profiles); await stopServers(); }
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
const list = want.length ? want : ['single', 'hostile', 'assist', 'prepare', 'queue', 'checkout-errors', 'renamed-selectors', 'applepay-turn', 'closed-backsoon', 'closed-redirect', 'closed-offsite', 'closed-blank', 'acceptance'];
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
