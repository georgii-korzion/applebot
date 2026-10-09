// Юнит-тесты чистых функций: node build.mjs --unit && node --test dist-test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { closedReloadMs, defaultConfig, defaultOrder, normalizeConfig, orderFor, phaseOf, validateConfig, jitter } from '../src/shared/config';
import { PARTS, getPart, matchBagName, partByPath, partUrl } from '../src/shared/parts';
import { fmtLine, maskEmail, maskPhone, maskUrl, rel, scrub } from '../src/shared/log';
import { orderWindows, parseSlot } from '../src/content/slots';
import { routeKey } from '../src/content/router';
import { fmUrl, parseFm } from '../src/shared/watch';

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
  const ok = { ...defaultConfig(), orders: [validOrder()] };
  assert.deepEqual(validateConfig(ok, now).errors, []);

  const bad = normalizeConfig({
    ...ok,
    orders: [
      { ...validOrder(), contact: { firstName: '', lastName: 'X', email: 'nope', phone: '0612345678' }, targets: ['ZZZ'], stores: ['R000'] },
    ],
  });
  const e = validateConfig(bad, now).errors.join('\n');
  assert.match(e, /пустое имя/);
  assert.match(e, /email/);
  assert.match(e, /05XXXXXXXX/);
  assert.match(e, /неизвестный парт ZZZ/);
  assert.match(e, /R000/);

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

  const localHub = normalizeConfig({ ...ok, hubUrl: 'ws://127.0.0.1:8765' });
  assert.ok(!/хаб не на этом компьютере/.test(validateConfig(localHub, now).warnings.join('\n')));
  const remoteHub = normalizeConfig({ ...ok, hubUrl: 'ws://192.168.1.20:8765' });
  assert.match(validateConfig(remoteHub, now).warnings.join('\n'), /хаб не на этом компьютере/);
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
  assert.match(fmUrl('https://www.apple.com', ['MK254AH/A'], 'R597'), /parts\.0=MK254AH%2FA&searchNearby=true&store=R597$/);
  const closed = parseFm('<!doctype html>', ['MK254AH/A'], ['R597']);
  assert.equal(closed.statuses['MK254AH/A'].isBuyable, false);
});
