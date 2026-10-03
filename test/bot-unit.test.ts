// Юнит-тесты бота (docs/BOT-SPEC.md §15): назначение заказов, пул карт, адаптация H1, сторож, очередь внимания,
// шаблоны уведомлений, валидация конфига и секретов, JSONC, форвардер прокси (HTTP и SOCKS5 с логином).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { CardPool } from '../bot/src/hub/cards';
import { AttentionQueue } from '../bot/src/hub/attention';
import { adaptTick, assignStrategies, isStuck, newAdapt, pickOrder } from '../bot/src/hub/policy';
import { DEFAULT_THRESHOLDS, normalizeBotConfig, normalizeSecrets, parseJsonc, toExtOrder, validateBot } from '../bot/src/config';
import { leaksSecrets, orderFileBlock, recipientOut, telegramText } from '../bot/src/notify/templates';
import { sign } from '../bot/src/notify';
import { Forwarder, openTunnel, parseProxyUrl, redactProxy } from '../bot/src/proxy/forwarder';
import { scrubHtml } from '../bot/src/hub/server';
import { isDeclineText, THREEDS_RE } from '../src/shared/bot';
import { scrub } from '../src/shared/log';

const card = (id: string, role: 'primary' | 'reserve', number: string, maxOrders = 2) => ({
  id, label: id, role, number, expiry: '12/29', cvv: '123', name: 'X', maxOrders,
  billing: { title: '', firstName: '', lastName: '', street: 'S', area: 'A', town: '', city: 'Dubai' },
});

test('карты: primary по кругу с учётом maxOrders, reserve — только на замену', () => {
  const p = new CardPool([card('c1', 'primary', '4111111111111111', 2), card('c2', 'primary', '5555555555554444', 1), card('c3', 'reserve', '4242424242424242', 2)]);
  assert.equal(p.assign('A')?.id, 'c1');
  assert.equal(p.assign('B')?.id, 'c2', 'по кругу — наименее загруженная');
  assert.equal(p.assign('C')?.id, 'c1');
  assert.equal(p.assign('D'), null, 'primary кончились (c1: 2, c2: 1), reserve не раздаётся');
  assert.equal(p.assign('A')?.id, 'c1', 'повторный ASSIGN — та же карта');
  assert.equal(p.replacement('B')?.id, 'c3', 'замена — reserve');
  assert.ok(!p.get('c2')!.orders.includes('B'), 'старая карта освободила место');
});

test('карты: отказ сжигает, ворота Place Order — одно ожидание на карту', () => {
  const p = new CardPool([card('c1', 'primary', '4111111111111111', 2), card('c3', 'reserve', '4242424242424242', 1)], undefined, 1, 1);
  p.assign('A'); p.assign('B');
  assert.equal(p.requestPlace('c1', 'b1', 'A'), 'granted');
  assert.equal(p.requestPlace('c1', 'b2', 'B'), 'queued', 'по карте уже ждут подтверждения банка');
  p.placed('c1', 'b1', 'A');
  const r = p.decline('c1', 'A');
  assert.equal(r.burned, true);
  assert.equal(r.next, null, 'по сгоревшей карте ход не выдаётся');
  assert.deepEqual(p.dropQueue('c1'), [{ browser: 'b2', orderId: 'B' }]);
  assert.equal(p.requestPlace('c1', 'b2', 'B'), 'burned');
  assert.equal(p.replacement('B')?.id, 'c3');
  assert.equal(p.replacement('C'), null, 'запасные кончились (maxOrders 1)');
  assert.ok(p.exhausted());
  assert.equal(p.unburn('c1'), true);
  assert.equal(p.get('c1')!.status, 'ACTIVE');
});

test('карты: оплата → исчерпание и ход следующему; протухший ход возвращается', () => {
  const p = new CardPool([card('c1', 'primary', '4111111111111111', 2)], undefined, 1, 1);
  p.assign('A'); p.assign('B');
  assert.equal(p.requestPlace('c1', 'b1', 'A', 1000), 'granted');
  assert.equal(p.requestPlace('c1', 'b2', 'B', 1000), 'queued');
  p.placed('c1', 'b1', 'A');
  assert.deepEqual(p.markPaid('c1', 'A'), { browser: 'b2', orderId: 'B' }, 'после заказа — ход второму');
  assert.equal(p.get('c1')!.status, 'ACTIVE');
  const q = new CardPool([card('c1', 'primary', '4111111111111111', 2)], undefined, 1, 1);
  q.assign('A'); q.assign('B');
  q.requestPlace('c1', 'b1', 'A', 1000);
  q.requestPlace('c1', 'b2', 'B', 1000);
  assert.deepEqual(q.expireGrants(30_000, 40_000), [{ browser: 'b2', orderId: 'B', cardId: 'c1' }], 'не нажал за 30 с — ход следующему');
  p.placed('c1', 'b2', 'B');
  p.markPaid('c1', 'B');
  assert.equal(p.get('c1')!.status, 'EXHAUSTED', 'maxOrders оплачено');
});

test('назначение: приоритет, claimersPerOrder, не на оплате, не провалившему', () => {
  const orders = [
    { id: 'A', priority: 1, state: 'PAY_READY' as const, claimers: ['b1'], failed: [] },
    { id: 'B', priority: 2, state: 'IN_BAG' as const, claimers: ['b2', 'b3'], failed: [] },
    { id: 'C', priority: 3, state: 'CLAIMED' as const, claimers: ['b4'], failed: ['b9'] },
    { id: 'D', priority: 4, state: 'OPEN' as const, claimers: [], failed: [] },
  ];
  const alive = (b: string) => b !== 'b3';
  assert.equal(pickOrder(orders, 2, 'b7', alive)?.id, 'B', 'A на оплате; у B живой претендент один (b3 мёртв)');
  assert.equal(pickOrder(orders, 1, 'b7', alive)?.id, 'D');
  assert.equal(pickOrder(orders, 2, 'b9', () => true)?.id, 'D', 'B полон, C — b9 уже провалил');
  assert.equal(pickOrder(orders.map((o) => ({ ...o, state: 'ORDERED' as const })), 2, 'b7', alive), null, 'заказов нет — SPARE');
});

test('H1: адаптация ступенями, два контрольных, ручная команда перекрывает', () => {
  const st = newAdapt();
  const fleet = [
    { id: 'b1', strategy: 'refresh' as const, admittedAt: 1000, admittedStrategy: 'refresh' as const },
    { id: 'b2', strategy: 'refresh' as const, admittedAt: 2000, admittedStrategy: 'refresh' as const },
    ...['b3', 'b4', 'b5', 'b6', 'b7', 'b8'].map((id) => ({ id, strategy: 'hold' as const })),
  ];
  assert.equal(adaptTick(st, fleet, 30_000, 45, 30), null, 'до 45 с после первого ADMITTED — ничего');
  const r1 = adaptTick(st, fleet, 47_000, 45, 30)!;
  assert.equal(r1.switches.length, 3, 'половина из 6 отстающих');
  assert.ok(r1.switches.every((s) => s.to === 'refresh'));
  for (const s of r1.switches) fleet.find((b) => b.id === s.id)!.strategy = 'refresh';
  assert.equal(adaptTick(st, fleet, 60_000, 45, 30), null, 'вторая ступень — через 30 с');
  const r2 = adaptTick(st, fleet, 78_000, 45, 30)!;
  assert.equal(r2.switches.length, 1, 'остальные кроме двух контрольных');
  assert.equal(adaptTick(st, fleet, 200_000, 45, 30), null, 'дальше — ничего');
  const m = newAdapt();
  m.manual = true;
  assert.equal(adaptTick(m, fleet, 47_000, 45, 30), null, 'ручная команда выключает автоматику');
  const tie = newAdapt();
  assert.equal(adaptTick(tie, [{ id: 'x', strategy: 'refresh', admittedAt: 1 }, { id: 'y', strategy: 'hold', admittedAt: 2 }], 50_000, 45, 30), null, 'обе пускают — не переключаем');
});

test('стратегии при запуске: доли и обе группы (прямые и прокси)', () => {
  const s = assignStrategies(8, { refresh: 0.5, hold: 0.5 }, [[0, 1, 2, 3], [4, 5, 6, 7]]);
  assert.equal(s.filter((x) => x === 'hold').length, 4);
  assert.ok(s.slice(0, 4).includes('hold') && s.slice(0, 4).includes('refresh'), 'прямые — в обеих группах');
  assert.ok(s.slice(4).includes('hold') && s.slice(4).includes('refresh'), 'прокси — в обеих группах');
  assert.deepEqual(assignStrategies(3, { refresh: 1, hold: 0 }, [[0, 1, 2]]), ['refresh', 'refresh', 'refresh']);
});

test('сторож: пороги §10, ожидания не трогает', () => {
  const pay = { threeDsSec: 300, applePaySec: 300 };
  const th = { ...DEFAULT_THRESHOLDS };
  assert.equal(isStuck('FULFILLMENT', 0, 39_000, th, pay), false);
  assert.equal(isStuck('FULFILLMENT', 0, 41_000, th, pay), true);
  assert.equal(isStuck('ATB_PENDING', 0, 21_000, th, pay), true);
  assert.equal(isStuck('QUEUE', 0, 10_000_000, th, pay), false, 'очередь — ожидание');
  assert.equal(isStuck('HOLD', 0, 10_000_000, th, pay), false);
  assert.equal(isStuck('PAY_QUEUE', 0, 10_000_000, th, pay), false);
  assert.equal(isStuck('WAIT_3DS', 0, 200_000, th, pay), false);
  assert.equal(isStuck('WAIT_3DS', 0, 400_000, th, pay), true);
  assert.equal(isStuck('REVIEW', 0, 60_000, th, pay, true), false, 'пробный прогон стоит на Review');
});

test('очередь внимания: приоритет, «Дальше», разрешение', () => {
  const q = new AttentionQueue();
  q.add({ browser: 'b1', reason: 'stuck', text: '', orderId: null, state: 'X', since: 1 });
  q.add({ browser: 'b2', reason: 'captcha', text: '', orderId: null, state: 'CAPTCHA', since: 2 });
  q.add({ browser: 'b3', reason: '3ds_input', text: '', orderId: 'A', state: 'WAIT_3DS', since: 3 });
  assert.equal(q.next()?.browser, 'b3', '3-D Secure с вводом — первым');
  assert.equal(q.next(), null, 'пока активное не разрешилось — следующего нет');
  assert.equal(q.resolve('b3'), true);
  assert.equal(q.next()?.browser, 'b2', 'капча раньше зависания');
  assert.equal(q.skip()?.browser, 'b1', '«Дальше» — следующее окно');
  assert.equal(q.skip()?.browser, 'b2', 'пропущенные — в конце');
  q.add({ browser: 'b1', reason: 'stuck', text: 'новый текст', orderId: null, state: 'Y' });
  assert.equal(q.items.filter((x) => x.browser === 'b1').length, 1, 'повод не дублируется');
});

test('шаблоны: order.placed, контакты по флагу, карта — только ****', () => {
  const r = { firstName: 'Ahmed', lastName: 'Test', email: 'ahmed.test@example.com', phone: '0501234567' };
  const e = {
    event: 'order.placed', ts: '2026-10-16T12:01:14.220Z', machine: 'mac1', browser: 'b07',
    order: { id: 'A', number: 'W1234567890', part: 'MK274AH/A', title: 'iPhone Duo 512GB Night Sky', storeName: 'Apple Dubai Mall', slot: 'October 16 18:15 – 18:30', total: 'AED 6,149.00' },
    recipient: recipientOut(r, true), payment: { method: 'card', cardLast4: '1234' }, proxy: 'AE-3', timings: { openToOrderSec: 74.2 },
  };
  const t = telegramText(e);
  assert.match(t, /✅ Заказ W1234567890/);
  assert.match(t, /0501234567 · ahmed\.test@example\.com/);
  assert.match(t, /Карта \*\*\*\*1234 · b07 · AE-3 · 74 с от OPEN/);
  assert.match(orderFileBlock(e), /Получатель: Ahmed Test · 0501234567 · ahmed\.test@example\.com/);
  const masked = recipientOut(r, false)!;
  assert.equal(masked.phone, '05******67');
  assert.ok(!masked.email.includes('ahmed.test'));
  assert.equal(leaksSecrets(JSON.stringify(e), ['4111111111111111']), null);
  assert.equal(leaksSecrets('card 4111111111111111', ['4111111111111111']), 'номер карты ****1111');
  assert.match(sign('{"a":1}', 's'), /^sha256=[0-9a-f]{64}$/);
  assert.match(telegramText({ event: 'human.needed', ts: '', machine: 'm', browser: 'b02', reason: 'captcha', text: 'x' }), /Нужен человек · b02: капча/);
});

const goodSecrets = () => normalizeSecrets({
  recipients: { r1: { firstName: 'A', lastName: 'B', email: 'a@example.com', phone: '0501234567' }, r2: { firstName: 'C', lastName: 'D', email: 'c@example.com', phone: '0521234567' } },
  cards: [card('c1', 'primary', '4111111111111111', 2)],
  proxies: [{ id: 'px1', url: 'http://u:p@1.2.3.4:8080' }],
  telegram: { botToken: '', chatId: '' },
});

test('конфиг бота: JSONC, дефолты, проверки §5', () => {
  const j = parseJsonc('{\n // комментарий\n "a": "http://x//y", /* блок */ "b": [1, 2,],\n}') as any;
  assert.equal(j.a, 'http://x//y', 'строки с // не трогаем');
  assert.deepEqual(j.b, [1, 2]);
  const cfg = normalizeBotConfig({ fleet: { browsers: 3 }, proxies: { mode: 'mixed', directBrowsers: 2 }, orders: [{ id: 'A', targets: ['mk254ah/a'], recipient: 'r1' }, { id: 'B', targets: ['MK244AH/A'], recipient: 'r2', payment: 'applepay' }] });
  assert.equal(cfg.orders[0].targets[0], 'MK254AH/A');
  assert.equal(cfg.orders[0].payment, 'card');
  assert.equal(cfg.notify.telegram.enabled, false, 'Telegram по умолчанию выключен (владелец: заказы в файл)');
  assert.equal(cfg.payment.applePay.sendQrScreenshot, false, 'QR в Telegram не шлём');
  assert.equal(cfg.payment.applePay.fullscreen, true);
  const ok = validateBot(cfg, goodSecrets(), { now: Date.parse('2026-10-01T00:00:00Z') });
  assert.deepEqual(ok.errors, []);
  const bad = validateBot(normalizeBotConfig({
    fleet: { browsers: 1 }, proxies: { mode: 'all' }, notify: { telegram: { enabled: true } },
    orders: [{ id: 'A', targets: ['ZZZ'], recipient: 'r1' }, { id: 'B', targets: ['MK244AH/A'], recipient: 'r1' }, { id: 'C', targets: ['MK244AH/A'], recipient: 'r9', stores: ['R000'] }],
    timing: { minReloadMs: 500 },
  }), normalizeSecrets({ recipients: { r1: { firstName: 'A', lastName: 'B', email: 'bad', phone: '0612345678' } }, cards: [card('c1', 'primary', '4111111111111112', 1)] }), { now: 0 });
  const e = bad.errors.join('\n');
  for (const re of [/неизвестный парт ZZZ/, /уже в заказе A/, /r9/, /R000/, /телефон/, /email/, /Луна/, /покрывают 1/, /браузеров 1 меньше, чем заказов 3/, /прокси не хватает/, /Telegram/, /1,5 с/]) assert.match(e, re);
  const noBill = validateBot(cfg, normalizeSecrets({ ...goodSecrets(), cards: [{ ...card('c1', 'primary', '4111111111111111'), billing: { street: '', area: '', city: '' } }] }), { now: 0 });
  assert.match(noBill.errors.join('\n'), /billing-адрес/);
  const mock = validateBot(normalizeBotConfig({ baseUrl: 'http://127.0.0.1:4777', orders: [{ id: 'A', targets: ['MK254AH/A'], recipient: 'r1' }], proxies: { mode: 'off' } }), goodSecrets(), { now: 0 });
  assert.match(mock.errors.join('\n'), /dev-сборкой/);
});

test('заказ бота → заказ расширения: card → manual, автонажатие по stopBeforePay', () => {
  const cfg = normalizeBotConfig({ orders: [{ id: 'A', targets: ['MK254AH/A'], recipient: 'r1' }] });
  const sec = goodSecrets();
  const o = toExtOrder(cfg, cfg.orders[0], sec.recipients.r1, sec.cards[0], 'card', 'b01');
  assert.equal(o.payment, 'manual');
  assert.equal(o.card.number, '4111111111111111');
  assert.equal(o.cardId, 'c1');
  assert.equal(o.autoPlaceOrder, true);
  assert.equal(o.racersPerProfile, 1);
  const dry = toExtOrder({ ...cfg, payment: { ...cfg.payment, stopBeforePay: true } }, cfg.orders[0], sec.recipients.r1, null, 'applepay', 'b01');
  assert.equal(dry.payment, 'applepay');
  assert.equal(dry.autoPlaceOrder, false);
  assert.equal(dry.card.number, '');
});

test('тексты отказа карты и 3-D Secure (§9.3), маскирование по privacy', () => {
  assert.ok(isDeclineText('Your payment was declined. Please use a different card.'));
  assert.ok(isDeclineText('The card could not be authorized'));
  assert.ok(!isDeclineText('An unexpected error occurred. Please try again.'), 'общая ошибка — не отказ');
  assert.ok(THREEDS_RE.test('Confirm the payment in your bank app'));
  const s = 'карта 4111 1111 1111 1111 email ahmed.test@example.com 0501234567 atbtoken=abcdef123456';
  const strict = scrub(s);
  assert.ok(!strict.includes('ahmed.test@') && !strict.includes('0501234567') && !strict.includes('4111 1111') && !strict.includes('abcdef1'));
  const bot = scrub(s, { maskContactsInLogs: false, maskCardInLogs: true, logTokens: false });
  assert.ok(bot.includes('ahmed.test@example.com') && bot.includes('0501234567'), 'бот: полные контакты в логе');
  assert.ok(!bot.includes('4111 1111') && bot.includes('****1111'), 'карта — всегда ****');
  assert.ok(!bot.includes('abcdef1234'));
  const h = scrubHtml('<script>{"x-aos-stk":"secret-token-123"}</script><a href="?atbtoken=abc123&x=1">4111111111111111');
  assert.ok(!h.includes('secret-token-123') && !h.includes('abc123') && !h.includes('4111111111111111'));
});

test('прокси: разбор адреса, HTTP CONNECT и SOCKS5 с логином, форвардер без авторизации для Chrome', async (t) => {
  assert.deepEqual(parseProxyUrl('http://us%40r:p%3Ass@1.2.3.4:3128'), { protocol: 'http', host: '1.2.3.4', port: 3128, user: 'us@r', pass: 'p:ss' });
  assert.equal(parseProxyUrl('socks5://a:b@h:1080').protocol, 'socks5');
  assert.equal(redactProxy('http://user:secret@h:1'), 'http://user:***@h:1');
  // цель
  const target = http.createServer((req, res) => res.end(`ok ${req.url}`));
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  t.after(() => { target.closeAllConnections(); target.close(); });
  const tport = (target.address() as net.AddressInfo).port;
  // HTTP-апстрим с логином
  const auth = `Basic ${Buffer.from('u:p').toString('base64')}`;
  const up = http.createServer((req, res) => {
    if (req.headers['proxy-authorization'] !== auth) { res.writeHead(407); return res.end(); }
    const u = new URL(req.url!);
    http.get({ host: u.hostname, port: u.port, path: u.pathname }, (r) => { res.writeHead(r.statusCode!, r.headers); r.pipe(res); });
  });
  up.on('connect', (req, sock) => {
    if (req.headers['proxy-authorization'] !== auth) { sock.end('HTTP/1.1 407 x\r\n\r\n'); return; }
    const [h, p] = req.url!.split(':');
    const c = net.connect(Number(p), h, () => { sock.write('HTTP/1.1 200 OK\r\n\r\n'); c.pipe(sock); sock.pipe(c); });
  });
  await new Promise<void>((r) => up.listen(0, '127.0.0.1', r));
  t.after(() => { up.closeAllConnections(); up.close(); });
  const upPort = (up.address() as net.AddressInfo).port;
  // SOCKS5 с логином
  const socks = net.createServer((c) => {
    c.once('data', () => {
      c.write(Buffer.from([5, 2]));
      c.once('data', (a) => {
        const ul = a[1]; const user = a.subarray(2, 2 + ul).toString(); const pl = a[2 + ul]; const pass = a.subarray(3 + ul, 3 + ul + pl).toString();
        if (user !== 'su' || pass !== 'sp') { c.end(Buffer.from([1, 1])); return; }
        c.write(Buffer.from([1, 0]));
        c.once('data', (q) => {
          const n = q[4]; const host = q.subarray(5, 5 + n).toString(); const port = q.readUInt16BE(5 + n);
          const t = net.connect(port, host, () => { c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])); t.pipe(c); c.pipe(t); });
        });
      });
    });
  });
  const socksConns = new Set<net.Socket>();
  socks.on('connection', (c) => { socksConns.add(c); c.on('close', () => socksConns.delete(c)); });
  await new Promise<void>((r) => socks.listen(0, '127.0.0.1', r));
  t.after(() => { for (const c of socksConns) c.destroy(); socks.close(); });
  const sPort = (socks.address() as net.AddressInfo).port;
  const get = (s: net.Socket) => new Promise<string>((resolve) => { let d = ''; s.on('data', (x) => (d += x)); s.on('end', () => resolve(d)); s.write(`GET /t HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`); });
  assert.match(await get(await openTunnel(parseProxyUrl(`http://u:p@127.0.0.1:${upPort}`), '127.0.0.1', tport)), /ok \/t/);
  assert.match(await get(await openTunnel(parseProxyUrl(`socks5://su:sp@127.0.0.1:${sPort}`), '127.0.0.1', tport)), /ok \/t/);
  await assert.rejects(openTunnel(parseProxyUrl(`http://u:bad@127.0.0.1:${upPort}`), '127.0.0.1', tport), /407/);
  await assert.rejects(openTunnel(parseProxyUrl(`socks5://su:bad@127.0.0.1:${sPort}`), '127.0.0.1', tport), /логин/);
  // форвардер: Chrome ходит без логина, форвардер подставляет его сам
  for (const url of [`http://u:p@127.0.0.1:${upPort}`, `socks5://su:sp@127.0.0.1:${sPort}`]) {
    const f = new Forwarder('px', parseProxyUrl(url), 0, { probe: `127.0.0.1:${tport}`, downAfterSec: 1 });
    // порт 0 — свободный: подменим после старта
    (f as any).port = 0;
    await f.start();
    const fport = ((f as any).server.address() as net.AddressInfo).port;
    const body = await new Promise<string>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: fport, path: `http://127.0.0.1:${tport}/plain` }, (r) => { let d = ''; r.on('data', (x) => (d += x)); r.on('end', () => resolve(d)); }).on('error', reject);
    });
    assert.equal(body, 'ok /plain', `форвардер (${url.split(':')[0]}): обычный HTTP`);
    const tun = await openTunnel({ protocol: 'http', host: '127.0.0.1', port: fport }, '127.0.0.1', tport);
    assert.match(await get(tun), /ok \/t/, 'форвардер: CONNECT');
    assert.ok(f.status().up && f.connects >= 2);
    f.stop();
  }
  // прокси умер → down через downAfterSec
  const f2 = new Forwarder('dead', parseProxyUrl('http://u:p@127.0.0.1:1'), 0, { probe: `127.0.0.1:${tport}`, downAfterSec: 1 });
  await f2.start();
  const down = await new Promise<boolean>((resolve) => { f2.once('down', () => resolve(true)); setTimeout(() => resolve(false), 8000); });
  f2.stop();
  assert.ok(down, 'событие down');
});
