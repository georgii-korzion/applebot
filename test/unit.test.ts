// Юнит-тесты чистых функций: node build.mjs --unit && node --test dist-test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TIMING, closedReloadMs, configUrlFromHub, defaultConfig, defaultOrder, huntStage, normalizeConfig, orderFor, parseIdentityHash, parseProxyLine, phaseOf, serverOf, validateConfig, jitter } from '../src/shared/config';
import { waitPlan } from '../src/shared/strategy';
import { PARTS, getPart, matchBagName, partByPath, partUrl } from '../src/shared/parts';
import { fmtLine, maskEmail, maskPhone, maskUrl, registerSecret, rel, scrub } from '../src/shared/log';
import { orderWindows, parseSlot } from '../src/content/slots';
import { routeKey } from '../src/content/router';
import { fmUrl, openEdge, openParts, parseFm, parseStores } from '../src/shared/watch';

const validOrder = () => ({
  ...defaultOrder('A'),
  contact: { firstName: 'Ahmed', lastName: 'Test', email: 'a@example.com', phone: '0501234567' },
});

test('parts: 8 Duo + 32 Pro/Pro Max, URL по шаблону §2.1', () => {
  assert.equal(Object.values(PARTS).filter((p) => p.family === 'iphone-duo').length, 8);
  assert.equal(Object.keys(PARTS).length, 40);
  assert.equal(partUrl('https://www.apple.com', 'MK254AH/A'), 'https://www.apple.com/ae/shop/buy-iphone/iphone-duo/7.6-inch-display-256gb-night-sky');
  assert.equal(partUrl('https://www.apple.com/', 'mjr54ah/a'), 'https://www.apple.com/ae/shop/buy-iphone/iphone-18-pro/6.3-inch-display-256gb-black');
  assert.equal(getPart('MK2C4AH/A')?.capacity, '2tb');
  assert.equal(partByPath('/ae/shop/buy-iphone/iphone-18-pro/6.9-inch-display-1tb-glacier/')?.part, 'MJXH4AH/A');
});

test('parts: название в корзине', () => {
  assert.equal(matchBagName('iPhone Duo 256GB Night Sky', 'MK254AH/A'), 'strict');
  assert.equal(matchBagName('iPhone Duo 256 GB Night Sky', 'MK254AH/A'), 'strict');
  assert.equal(matchBagName('iPhone Duo 256GB Star White', 'MK254AH/A'), 'loose');
  assert.equal(matchBagName('iPhone Duo 512GB Night Sky', 'MK254AH/A'), false);
  assert.equal(matchBagName('iPhone 18 Pro Max 256GB Black', 'MJR54AH/A'), false, 'Pro ≠ Pro Max');
  assert.equal(matchBagName('iPhone 18 Pro 256GB Black Titanium', 'MJR54AH/A'), 'strict');
  assert.equal(matchBagName('iPhone 18 Pro Max 1TB Glacier', 'MJXH4AH/A'), 'strict');
});

test('config: нормализация и дефолты', () => {
  const c = normalizeConfig({ profileId: 'drop-2', orders: [{ id: 'B', targets: ['mk254ah/a'], contact: { phone: '050 123-4567' }, slot: { day: 23 } }] });
  assert.equal(c.orders[0].targets[0], 'MK254AH/A');
  assert.equal(c.orders[0].contact.phone, '0501234567');
  assert.equal(c.orders[0].slot.day, '23');
  assert.equal(c.timing.minReloadMs, 1500);
  assert.equal(c.mode, 'auto');
});

test('config: валидация §10', () => {
  const now = Date.parse('2026-10-01T00:00:00Z');
  const ok = { ...defaultConfig(), profileId: 'drop-1', orders: [validOrder()] };
  assert.deepEqual(validateConfig(ok, now).errors, []);

  const bad = normalizeConfig({
    ...ok,
    orders: [
      { ...validOrder(), contact: { firstName: '', lastName: 'X', email: 'nope', phone: '0612345678' }, targets: ['ZZZ'], stores: ['R000', 'X1'] },
    ],
  });
  const e = validateConfig(bad, now).errors.join('\n');
  assert.match(e, /пустое имя/);
  assert.match(e, /email/);
  assert.match(e, /05XXXXXXXX/);
  assert.match(e, /неизвестный парт ZZZ/);
  assert.match(e, /X1/, 'код не по формату R + цифры — ошибка');
  assert.match(validateConfig(bad, now).warnings.join('\n'), /R000/, 'неизвестный код по формату — предупреждение (можно добавить магазин)');

  const two = normalizeConfig({ ...ok, orders: [{ ...validOrder(), profiles: ['drop-1'] }, { ...validOrder(), id: 'B', profiles: ['drop-1'] }] });
  assert.match(validateConfig(two, now).errors.join('\n'), /нескольким заказам/);

  const many = normalizeConfig({ ...ok, orders: [{ ...validOrder(), profiles: ['drop-1', 'drop-2', 'drop-3', 'drop-4', 'drop-5'], racersPerProfile: 3 }] });
  assert.match(validateConfig(many, now).errors.join('\n'), /maxTabsTotal/);

  const fast = normalizeConfig({ ...ok, timing: { minReloadMs: 500, pollMs: 300 } });
  assert.match(validateConfig(fast, now).errors.join('\n'), /1,5 с/);
  assert.match(validateConfig(fast, now).errors.join('\n'), /pollMs/);

  const past = normalizeConfig({ ...ok, openAt: '2026-09-01T00:00:00+04:00' });
  assert.deepEqual(validateConfig(past, now).errors, []);
  assert.match(validateConfig(past, now).warnings.join('\n'), /openAt в прошлом/);
});

test('config: заказ профиля', () => {
  const c = normalizeConfig({ profileId: 'drop-3', orders: [{ ...validOrder(), profiles: ['drop-1'] }, { ...validOrder(), id: 'B', profiles: ['drop-3'] }] });
  assert.equal(orderFor(c)?.id, 'B');
  assert.equal(orderFor(c, 'drop-9'), undefined);
});

test('jitter ±pct', () => {
  for (let i = 0; i < 200; i++) {
    const v = jitter(1000, 30);
    assert.ok(v >= 700 && v <= 1300);
  }
});

test('слоты: разбор и порядок §7.6', () => {
  assert.deepEqual(parseSlot('28-19:15-19:30'), { day: '28', start: '19:15', end: '19:30' });
  assert.deepEqual(parseSlot('3-9:00-9:15'), { day: '3', start: '09:00', end: '09:15' });
  const opts = ['16-16:15-16:30', '16-16:30-16:45', '16-18:00-18:15', '16-19:45-20:00'].map((value) => ({ value, label: value }));
  assert.deepEqual(orderWindows(opts, { after: '18:00', before: '19:00' }).map((o) => o.value),
    ['16-18:00-18:15', '16-16:15-16:30', '16-16:30-16:45', '16-19:45-20:00']);
  assert.deepEqual(orderWindows(opts, { after: null, before: null }).map((o) => o.value), opts.map((o) => o.value));
});

test('лог: маскирование — без токенов и полных контактов', () => {
  const u = maskUrl('/ae/shop/x?acpart=none&atbtoken=0123456789abcdef0123456789abcdef01234567&igt=true&add-to-cart=add-to-cart');
  assert.match(u, /atbtoken=0123…&igt=true/);
  assert.equal(maskUrl('/ae/shop/signIn?ssi=1AAAxyz&x=1'), '/ae/shop/signIn?ssi=…&x=1');
  assert.equal(maskEmail('ahmed.test@example.com'), 'ah***@e***.com');
  assert.equal(maskPhone('0501234567'), '05******67');
  const s = scrub('contact ahmed.test@example.com 0501234567 token 0123456789abcdef0123456789abcdef');
  assert.ok(!s.includes('ahmed.test@example.com'));
  assert.ok(!s.includes('0501234567'));
  assert.ok(!s.includes('0123456789abcdef0123456789abcdef'));
});

test('лог: формат строки §7.10', () => {
  const opened = Date.parse('2026-10-16T12:00:00Z');
  const line = fmtLine({ ts: opened + 3120, openedAt: opened, profile: 'drop-1', order: 'A', tab: 12, state: 'ATB_PENDING', msg: 'клик' });
  assert.match(line, /^\[\d\d:\d\d:\d\d\.\d{3} \+3\.120\] \[drop-1 · A · 12\] ATB_PENDING: клик$/);
  assert.equal(rel(opened - 47_900, undefined, opened), 'T-47.9');
});

test('router: ключ шага SPA', () => {
  assert.notEqual(routeKey('https://secure7.store.apple.com/ae/shop/checkout?_s=Fulfillment-init'), routeKey('https://secure7.store.apple.com/ae/shop/checkout?_s=PickupContact-init'));
  assert.equal(routeKey('https://www.apple.com/ae/shop/bag?a=1'), routeKey('https://www.apple.com/ae/shop/bag?a=2'));
});

test('фазы и рефреш закрытого магазина', () => {
  const cfg = { ...defaultConfig(), openAt: '2026-10-16T16:00:00+04:00' };
  const openAt = Date.parse(cfg.openAt);
  assert.equal(phaseOf(cfg, undefined, openAt - 3_600_000), 'armed');
  assert.equal(phaseOf(cfg, undefined, openAt - 30_000), 'pre');
  assert.equal(phaseOf(cfg, undefined, openAt + 1), 'post', 'с openAt — без ожидания graceSec');
  assert.equal(phaseOf(cfg, openAt - 90_000, openAt - 90_000), 'post', 'OPEN раньше openAt');
  for (let i = 0; i < 100; i++) {
    const a = closedReloadMs(cfg, undefined, openAt - 3_600_000);
    assert.ok(a >= 21000 && a <= 39000, `armed ${a}`);
    const p = closedReloadMs(cfg, undefined, openAt - 10_000);
    assert.ok(p >= 2100 && p <= 3900, `pre ${p}`);
    const q = closedReloadMs(cfg, undefined, openAt + 5000);
    assert.ok(q >= 1500 && q <= 1950, `post ${q} (не чаще minReloadMs)`);
  }
});

test('router: -init не считается сменой шага', () => {
  assert.equal(routeKey('https://secure7.store.apple.com/ae/shop/checkout?_s=Fulfillment-init'), routeKey('https://secure7.store.apple.com/ae/shop/checkout?_s=Fulfillment'));
});

test('watch: разбор fulfillment-messages', () => {
  const j = { body: { content: {
    deliveryMessage: {
      'MK254AH/A': { compact: { buyability: { isBuyable: false, reason: 'COMING_SOON' }, quote: '' } },
      'MJR54AH/A': { compact: { buyability: { isBuyable: true }, quote: 'Delivers Oct 23' } },
    },
    pickupMessage: { stores: [
      { storeNumber: 'R597', partsAvailability: { 'MJR54AH/A': { pickupDisplay: 'available' } } },
      { storeNumber: 'R999', partsAvailability: { 'MJR54AH/A': { pickupDisplay: 'available' } } },
    ] },
  } } };
  const r = parseFm(j, ['MK254AH/A', 'MJR54AH/A'], ['R597']);
  assert.equal(r.statuses['MK254AH/A'].isBuyable, false);
  assert.equal(r.statuses['MK254AH/A'].reason, 'COMING_SOON');
  assert.equal(r.statuses['MJR54AH/A'].isBuyable, true);
  assert.deepEqual(r.pick, ['R597:MJR54AH/A=available']);
  assert.deepEqual(r.pickupParts, ['MJR54AH/A'], 'самовывоз доступен только в магазине из конфига');
  assert.match(fmUrl('https://www.apple.com', ['MK254AH/A'], 'R597'), /parts\.0=MK254AH%2FA&searchNearby=true&store=R597$/);
  const closed = parseFm('<!doctype html>', ['MK254AH/A'], ['R597']);
  assert.equal(closed.statuses['MK254AH/A'].isBuyable, false);
});

test('watch: сигнал OPEN — pickup/delivery/any и фазы §7.3 (товар в продаже до дропа)', () => {
  const r = { buyable: ['A', 'B'], pickupParts: ['B'] };
  assert.deepEqual(openParts(r, 'pickup', ['A', 'B', 'C']), ['B']);
  assert.deepEqual(openParts(r, 'delivery', ['A', 'B', 'C']), ['A', 'B']);
  assert.deepEqual(openParts(r, 'any', ['C', 'B', 'A']), ['B', 'A'], 'порядок как в targets');
  assert.deepEqual(openParts({ buyable: [], pickupParts: [] }, 'any', ['A']), []);
  // до openAt−60 с — никогда, даже если сигнал есть
  assert.equal(openEdge(undefined, true, 'armed'), false);
  assert.equal(openEdge(false, true, 'armed'), false);
  // последняя минута — только фронт «не было → появилось»
  assert.equal(openEdge(false, true, 'pre'), true);
  assert.equal(openEdge(true, true, 'pre'), false, 'было доступно и раньше — это не открытие дропа');
  assert.equal(openEdge(undefined, true, 'pre'), false, 'первый опрос без истории — ждём openAt');
  assert.equal(openEdge(false, false, 'pre'), false);
  // после openAt — пока сигнал есть
  assert.equal(openEdge(true, true, 'post'), true);
  assert.equal(openEdge(undefined, true, 'post'), true);
  assert.equal(openEdge(true, false, 'post'), false);
  // конфиг: openSignal и новые тайминги
  assert.equal(normalizeConfig({}).openSignal, 'pickup');
  assert.equal(normalizeConfig({ openSignal: 'any' }).openSignal, 'any');
  assert.equal(normalizeConfig({ openSignal: 'weird' }).openSignal, 'pickup');
  const t = normalizeConfig({}).timing;
  assert.deepEqual([t.armedPollMs, t.pickupWaitMin, t.pickupRetryMs, t.restockMin, t.restockRetryMs], [20000, 30, 3000, 60, 5000]);
  assert.deepEqual([t.atbTimeoutMs, t.cardWaitMs, t.holdFallbackSec, t.holdReloadMs], [60000, 90000, 0, 60000], 'v5: step=attach 60 с, карта 90 с, hold без отката');
  const base = { profileId: 'x', orders: [validOrder()] };
  assert.ok(validateConfig(normalizeConfig({ ...base, timing: { pickupRetryMs: 1000 } })).errors.some((e) => /pickupRetryMs/.test(e)));
  assert.ok(validateConfig(normalizeConfig({ ...base, timing: { restockRetryMs: 1000 } })).errors.some((e) => /restockRetryMs/.test(e)));
  assert.ok(validateConfig(normalizeConfig({ ...base, timing: { armedPollMs: 500 } })).errors.some((e) => /armedPollMs/.test(e)));
  assert.ok(!validateConfig(normalizeConfig({ ...base, timing: { pickupWaitMin: 0, pickupRetryMs: 100 } })).errors.some((e) => /pickup/.test(e)), 'pickupWaitMin=0 — повторов нет, интервал не проверяем');
  assert.equal(normalizeConfig({ timing: { pickupWaitSec: 600 } }).timing.pickupWaitMin, 10, 'старый pickupWaitSec из 4.0 переводится в минуты');
  assert.equal(normalizeConfig({ timing: { pickupWaitSec: 600, pickupWaitMin: 5 } }).timing.pickupWaitMin, 5);
});

// ---------- FLEET-SPEC ----------

test('fleet: стратегии ожидания — таблица §4.2 построчно', () => {
  const t = DEFAULT_TIMING;
  // товар до старта («Continue»)
  assert.equal(waitPlan('refresh', 'armed', 'preorder', {}, t).reload, null, 'до openAt−60 с никто не рефрешит');
  assert.equal(waitPlan('hold', 'armed', 'preorder', {}, t).reload, null);
  assert.equal(waitPlan('refresh', 'pre', 'preorder', {}, t).reload, t.preOpenReloadMs, 'refresh: последняя минута — 3 с');
  assert.equal(waitPlan('hold', 'pre', 'preorder', {}, t).reload, null, 'hold: последняя минута — только JSON');
  assert.equal(waitPlan('refresh', 'post', 'preorder', { sinceOpenAt: 5000 }, t).reload, t.postOpenReloadMs, 'refresh: после openAt — 1.5 с');
  assert.equal(waitPlan('hold', 'post', 'preorder', { sinceOpenAt: 5000 }, t).reload, null, 'hold: после openAt — ждём');
  assert.equal(waitPlan('hold', 'post', 'preorder', { sinceOpenAt: 3_600_000 }, t).reload, null, 'v5: hold с holdFallbackSec 0 стоит, пока не пустят');
  const t300 = { ...t, holdFallbackSec: 300 };
  const fb = waitPlan('hold', 'post', 'preorder', { sinceOpenAt: 300_000 }, t300);
  assert.equal(fb.fallback, true, 'hold через holdFallbackSec переходит на refresh');
  assert.equal(fb.reload, t.postOpenReloadMs);
  assert.equal(waitPlan('hold', 'post', 'preorder', { sinceOpenAt: 299_000 }, t300).reload, null);
  assert.equal(waitPlan('hold', 'post', 'preorder', { sinceOpenAt: 1000, opened: true }, t).reload, t.postOpenReloadMs, 'после своего OPEN стратегии не различаются');
  // заглушка нагрузки
  assert.equal(waitPlan('hold', 'post', 'busy', { metaRefreshSec: 30 }, t).reload, null, 'hold + meta refresh — не трогаем');
  assert.equal(waitPlan('hold', 'post', 'busy', { waitedMs: 0 }, t).reload, t.holdBusyWaitSec * 1000, 'hold без meta — рефреш через holdBusyWaitSec');
  assert.equal(waitPlan('hold', 'post', 'busy', { waitedMs: t.holdBusyWaitSec * 1000 }, t).fallback, true);
  const b0 = waitPlan('refresh', 'post', 'busy', { busyInRow: 0 }, t).reload!;
  const b3 = waitPlan('refresh', 'post', 'busy', { busyInRow: 3 }, t).reload!;
  const b9 = waitPlan('refresh', 'post', 'busy', { busyInRow: 9 }, t).reload!;
  assert.ok(b0 >= t.minReloadMs && b0 < b3 && b3 <= b9 && b9 <= 4000, `refresh: бэкофф ${b0} → ${b3} → ${b9} ≤ 4 с`);
  assert.equal(waitPlan('refresh', 'post', 'busy', { busyInRow: 0, metaRefreshSec: 10 }, t).reload, 15000, 'refresh + meta: наш рефреш лишь страховка (meta+5 с)');
  assert.equal(waitPlan('refresh', 'armed', 'busy', {}, t).reload, t.closedReloadMs, 'refresh до старта — по фазе');
  // очередь Apple
  assert.equal(waitPlan('refresh', 'post', 'queue', { waitedMs: 0 }, t).reload, t.queueMaxWaitSec * 1000);
  assert.equal(waitPlan('hold', 'post', 'queue', { waitedMs: 0 }, t).reload, t.holdQueueWaitSec * 1000, 'hold ждёт очередь дольше');
  assert.equal(waitPlan('refresh', 'post', 'queue', { waitedMs: t.queueMaxWaitSec * 1000 + 1 }, t).fallback, true, 'очередь не пустила — рефреш');
  assert.equal(waitPlan('hold', 'post', 'queue', { waitedMs: t.queueMaxWaitSec * 1000 + 1 }, t).fallback, undefined, 'hold ещё ждёт');
  // закрыто / 404
  assert.equal(waitPlan('refresh', 'pre', 'closed', {}, t).reload, t.preOpenReloadMs, 'refresh: закрыто — по фазе');
  assert.equal(waitPlan('hold', 'pre', 'closed', {}, t).reload, t.holdReloadMs, 'hold: закрыто — раз в минуту всегда');
  assert.equal(waitPlan('hold', 'post', 'closed', {}, t).reload, 60000, 'hold: заглушка после openAt — тоже раз в минуту, без частого рефреша');
  assert.equal(waitPlan('refresh', 'post', 'closed', {}, t).reload, t.postOpenReloadMs, 'refresh: заглушка после openAt — рефреш сразу');
  assert.equal(waitPlan('hold', 'post', 'closed', { opened: true }, t).reload, t.postOpenReloadMs);
});

test('fleet: имя клона из адреса запуска §6', () => {
  assert.deepEqual(parseIdentityHash('#drop=nl1-p01&hub=wss%3A%2F%2Fhub.example.com%2Fws%3Ftoken%3Dabc'), { profileId: 'nl1-p01', hubUrl: 'wss://hub.example.com/ws?token=abc' });
  assert.deepEqual(parseIdentityHash('drop=ae1-p02'), { profileId: 'ae1-p02', hubUrl: '' });
  assert.equal(parseIdentityHash('#x=1'), null, 'без drop= — не наш хеш');
  assert.equal(parseIdentityHash('#drop='), null);
  assert.equal(parseIdentityHash(''), null);
  assert.equal(serverOf('nl1-p01'), 'nl1');
  assert.equal(serverOf('solo'), 'solo');
  assert.equal(configUrlFromHub('wss://hub.example.com/ws?token=abc', 'nl1-p01'), 'https://hub.example.com/config/nl1-p01?token=abc');
  assert.equal(configUrlFromHub('ws://127.0.0.1:8765/ws', 'a/b'), 'http://127.0.0.1:8765/config/a%2Fb');
  assert.equal(configUrlFromHub('https://hub.example.com/', 'x'), null, 'хаб — только ws/wss');
  assert.equal(configUrlFromHub('', 'x'), null);
  assert.equal(configUrlFromHub('wss://h/ws', ''), null);
});

test('fleet: нормализация новых полей §4/§7/§8', () => {
  const c = normalizeConfig({
    profileId: 'nl1-p01', strategy: 'hold', autoStart: 1, version: '3', cfgHash: 'abcd', ipCheckUrl: '',
    proxy: { scheme: 'http', host: 'p.example.com', port: '8000', username: 'u', password: 'secret-pass', bypass: ['<-loopback>', ''] },
    orders: [{ id: 'A', applePayClick: 'dom', applePayRetries: '5' }],
  });
  assert.equal(c.strategy, 'hold');
  assert.equal(c.autoStart, true);
  assert.equal(c.version, 3);
  assert.equal(c.cfgHash, 'abcd');
  assert.equal(c.ipCheckUrl, 'https://ipinfo.io/json', 'пустой ipCheckUrl → по умолчанию');
  assert.deepEqual(c.proxy, { scheme: 'http', host: 'p.example.com', port: 8000, username: 'u', password: 'secret-pass', bypass: ['<-loopback>'] });
  assert.equal(c.orders[0].applePayClick, 'dom');
  assert.equal(c.orders[0].applePayRetries, 5);
  const d = normalizeConfig({ profileId: 'x', strategy: 'weird', proxy: { scheme: 'socks5' }, orders: [{ id: 'A' }] });
  assert.equal(d.strategy, 'refresh', 'неизвестная стратегия → refresh');
  assert.equal(d.proxy, null, 'прокси без host/port → нет прокси');
  assert.equal(d.autoStart, true, 'v5: autoStart по умолчанию включён');
  assert.equal(d.orders[0].applePayClick, 'debugger');
  assert.equal(d.orders[0].applePayRetries, 3);
  const v = validateConfig(normalizeConfig({ profileId: 'nl1-p01', proxy: { host: 'h', port: 0 }, orders: [validOrder()] }));
  assert.ok(v.errors.some((e) => /proxy\.port/.test(e)), `прокси без порта — ошибка: ${v.errors}`);
});

test('fleet: секреты в логе — пароль прокси и токены скрыты §11', () => {
  registerSecret('Qw7Zx-test-pass');
  registerSecret('');
  registerSecret('ab'); // слишком короткий — не регистрируется (иначе замажет пол-лога)
  const s = scrub('прокси http://user:Qw7Zx-test-pass@p.example.com:8000 применён, ab ok, hub wss://h/ws?token=SECRETTOKEN');
  assert.ok(!s.includes('Qw7Zx-test-pass'), s);
  assert.ok(s.includes('***'), s);
  assert.ok(s.includes('ab ok'), 'короткая строка не маскируется');
  assert.ok(!s.includes('SECRETTOKEN'), `token= в URL скрыт: ${s}`);
  assert.equal(maskUrl('wss://h/ws?token=abc&x=1'), 'wss://h/ws?token=…&x=1');
});

// ---------- v5 ----------

test('v5: стадии охоты — дроп 30 мин, рестоки до 60 мин', () => {
  const openAt = Date.parse('2026-10-16T12:00:00Z');
  const cfg = normalizeConfig({ openAt: '2026-10-16T16:00:00+04:00' });
  const min = 60_000;
  assert.equal(huntStage(cfg, openAt - 3600_000, openAt - 1000).stage, 'before');
  assert.equal(huntStage(cfg, openAt - 3600_000, openAt + 1000).stage, 'drop');
  assert.equal(huntStage(cfg, openAt - 3600_000, openAt + 29 * min).stage, 'drop');
  assert.equal(huntStage(cfg, openAt - 3600_000, openAt + 30 * min).stage, 'restock');
  assert.equal(huntStage(cfg, openAt - 3600_000, openAt + 59 * min).stage, 'restock');
  assert.equal(huntStage(cfg, openAt - 3600_000, openAt + 60 * min).stage, 'over');
  // Start после openAt — отсчёт от Start
  const late = openAt + 2 * 3600_000;
  assert.equal(huntStage(cfg, late, late + 10 * min).stage, 'drop');
  assert.equal(huntStage(cfg, late, late + 45 * min).stage, 'restock');
  // «Рестоки»: openAt = момент нажатия, без фазы дропа
  const ra = normalizeConfig({ openAt: new Date(late).toISOString() });
  ra.restockAt = late;
  assert.equal(huntStage(ra, late, late + 1000).stage, 'restock');
  assert.equal(huntStage(ra, late, late + 59 * min).stage, 'restock');
  assert.equal(huntStage(ra, late, late + 61 * min).stage, 'over');
  // restockMin 0 — после 30 мин охота заканчивается
  const noRs = normalizeConfig({ openAt: '2026-10-16T16:00:00+04:00', timing: { restockMin: 0 } });
  assert.equal(huntStage(noRs, openAt, openAt + 31 * min).stage, 'over');
});

test('v5: autoStart и Add to Bag при Start по умолчанию включены', () => {
  assert.equal(normalizeConfig({}).autoStart, true);
  assert.equal(normalizeConfig({ autoStart: false }).autoStart, false);
  assert.equal(normalizeConfig({}).atbAtStart, true);
  assert.equal(normalizeConfig({ atbAtStart: 0 }).atbAtStart, false);
});

test('v5: прокси одной строкой', () => {
  assert.deepEqual(parseProxyLine('http://u:p@1.2.3.4:8000'), { scheme: 'http', host: '1.2.3.4', port: 8000, username: 'u', password: 'p' });
  assert.deepEqual(parseProxyLine('u:p@host.example:3128'), { scheme: 'http', host: 'host.example', port: 3128, username: 'u', password: 'p' });
  assert.deepEqual(parseProxyLine('host.example:3128'), { scheme: 'http', host: 'host.example', port: 3128 });
  assert.equal(parseProxyLine('socks5://h:1080')?.scheme, 'socks5');
  assert.equal(parseProxyLine('none'), null);
  assert.equal(parseProxyLine('  '), null);
  assert.throws(() => parseProxyLine('u:secretpass@host'), (e: Error) => !/secretpass/.test(e.message), 'в ошибке пароль скрыт');
});

test('v5: коды магазинов из JSON Apple', () => {
  const j = { body: { content: { pickupMessage: { stores: [
    { storeNumber: 'R597', storeName: 'Dubai Mall', city: 'Dubai' },
    { storeNumber: 'R706', storeName: 'Apple Al Maryah Island', address: { city: 'Abu Dhabi' } },
    { storeNumber: 'R597', storeName: 'Dubai Mall', city: 'Dubai' },
    { storeName: 'без номера' },
  ] } } } };
  assert.deepEqual(parseStores(j), [
    { id: 'R597', name: 'Apple Dubai Mall', city: 'Dubai' },
    { id: 'R706', name: 'Apple Al Maryah Island', city: 'Abu Dhabi' },
  ]);
  assert.deepEqual(parseStores(null), []);
  const base = { profileId: 'x', orders: [{ ...validOrder(), stores: ['R597', 'r12'] }] };
  assert.ok(validateConfig(normalizeConfig(base)).errors.some((e) => /r12|R12/.test(e)), 'код магазина — R и 3–4 цифры');
  const extra = { profileId: 'x', orders: [{ ...validOrder(), stores: ['R597', 'R999'] }] };
  const v = validateConfig(normalizeConfig(extra));
  assert.ok(!v.errors.some((e) => /R999/.test(e)), 'неизвестный, но правильный код — не ошибка');
  assert.ok(v.warnings.some((e) => /R999/.test(e)), '…а предупреждение');
});
