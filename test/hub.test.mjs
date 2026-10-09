// Юнит-тесты хаба (fleet.json → конфиг профиля): node --test test/hub.test.mjs (после node build.mjs --hub).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAll, buildProfileConfig, fleetHash, mergeProfile, parseFleet, profileIds } from '../hub/config.mjs';

const contact = (n) => ({ firstName: `Name${n}`, lastName: 'Test', email: `n${n}@example.com`, phone: `050123456${n}` });
const fleet = () => ({
  version: 7,
  openAt: '2026-10-16T16:00:00+04:00',
  baseUrl: 'https://www.apple.com',
  timing: { graceSec: 25 },
  defaults: {
    strategy: 'refresh', autoStart: true, targets: ['MJR54AH/A', 'MJX54AH/A'], stores: ['R597'], payment: 'applepay',
    applePayRetries: 3, slot: { day: null, after: null, before: null },
    billing: { title: 'Mr.', street: 'Sheikh Zayed Rd 1', area: 'Downtown', city: 'Dubai' },
    proxy: { scheme: 'http', host: 'proxy.example.com', port: 8000, username: 'u', password: 'p' },
    timing: { cardWaitMs: 60000 },
  },
  profiles: {
    'nl1-p01': { strategy: 'hold', contact: contact(1), timing: { cardWaitMs: 45000 } },
    'nl1-p02': { proxy: null, payment: 'manual', card: { number: '4111111111111111', expiry: '12/29', cvv: '123', name: 'N TEST' }, contact: contact(2), billing: { title: 'Ms.', street: 'Al Wasl Rd 10' } },
    'ae1-p01': { contact: { firstName: 'Omar' } },
  },
});

test('hub: defaults + профиль — вложенные объекты сливаются, proxy: null снимает прокси', () => {
  const f = fleet();
  const m1 = mergeProfile(f.defaults, f.profiles['nl1-p01']);
  assert.equal(m1.strategy, 'hold');
  assert.equal(m1.proxy.host, 'proxy.example.com', 'прокси по умолчанию унаследован');
  assert.equal(m1.timing.cardWaitMs, 45000, 'timing слит по ключам');
  const m2 = mergeProfile(f.defaults, f.profiles['nl1-p02']);
  assert.equal(m2.proxy, null, 'proxy: null у профиля снимает прокси');
  assert.deepEqual(m2.billing, { title: 'Ms.', street: 'Al Wasl Rd 10', area: 'Downtown', city: 'Dubai' }, 'billing: свои ключи поверх общих');
  assert.equal(m2.payment, 'manual');
  assert.deepEqual(mergeProfile(f.defaults, {}).targets, ['MJR54AH/A', 'MJX54AH/A']);
});

test('hub: конфиг профиля — один заказ = профиль, версия и хеш, стратегия, прокси, таймауты', () => {
  const f = fleet();
  const r = buildProfileConfig(f, 'nl1-p01', { hubUrl: 'wss://hub.example.com/ws?token=t', version: 7, hash: 'deadbeef' });
  assert.ok(r, 'профиль описан');
  assert.deepEqual(r.validation.errors, [], r.validation.errors.join('; '));
  const c = r.config;
  assert.equal(c.profileId, 'nl1-p01');
  assert.equal(c.hubUrl, 'wss://hub.example.com/ws?token=t');
  assert.equal(c.version, 7);
  assert.equal(c.cfgHash, 'deadbeef');
  assert.equal(c.strategy, 'hold');
  assert.equal(c.autoStart, true);
  assert.equal(c.openAt, f.openAt);
  assert.equal(c.baseUrl, 'https://www.apple.com');
  assert.equal(c.proxy.host, 'proxy.example.com');
  assert.equal(c.proxy.password, 'p');
  assert.equal(c.timing.graceSec, 25, 'timing с верхнего уровня');
  assert.equal(c.timing.cardWaitMs, 45000, 'timing профиля поверх defaults');
  assert.equal(c.timing.holdFallbackSec, 300, 'остальное — §10');
  assert.equal(c.orders.length, 1);
  const o = c.orders[0];
  assert.equal(o.id, 'nl1-p01');
  assert.equal(o.priority, 1);
  assert.deepEqual(o.profiles, ['nl1-p01']);
  assert.equal(o.racersPerProfile, 1);
  assert.deepEqual(o.targets, ['MJR54AH/A', 'MJX54AH/A']);
  assert.equal(o.payment, 'applepay');
  assert.equal(o.applePayClick, 'debugger');
  assert.equal(o.contact.email, 'n1@example.com');
  assert.equal(o.billing.street, 'Sheikh Zayed Rd 1');
  // профиль с картой и без прокси
  const r2 = buildProfileConfig(f, 'nl1-p02', { version: 7, hash: 'x' });
  assert.deepEqual(r2.validation.errors, []);
  assert.equal(r2.config.proxy, null);
  assert.equal(r2.config.orders[0].payment, 'manual');
  assert.equal(r2.config.orders[0].card.number, '4111111111111111');
  assert.equal(r2.config.orders[0].billing.title, 'Ms.');
});

test('hub: неизвестный профиль → null; неполный контакт → ошибки валидации (422)', () => {
  const f = fleet();
  assert.equal(buildProfileConfig(f, 'nope', {}), null);
  const r = buildProfileConfig(f, 'ae1-p01', { version: 1, hash: 'h' });
  assert.ok(r.validation.errors.length >= 2, `ошибки: ${r.validation.errors}`);
  assert.ok(r.validation.errors.some((e) => /фамилия/.test(e)));
  assert.ok(r.validation.errors.some((e) => /email/.test(e)));
  const all = buildAll(f, { version: 1, hash: 'h' });
  assert.deepEqual(Object.keys(all).sort(), ['ae1-p01', 'nl1-p01', 'nl1-p02']);
  assert.equal(all['nl1-p01'].validation.errors.length, 0);
  assert.ok(all['ae1-p01'].validation.errors.length > 0);
});

test('hub: разбор fleet.json — понятные ошибки, стабильный хеш', () => {
  const text = JSON.stringify(fleet());
  const { fleet: f, hash } = parseFleet(text);
  assert.deepEqual(profileIds(f), ['nl1-p01', 'nl1-p02', 'ae1-p01']);
  assert.equal(hash, fleetHash(text));
  assert.equal(hash.length, 16);
  assert.notEqual(fleetHash(text), fleetHash(`${text} `), 'любое изменение файла меняет хеш');
  assert.throws(() => parseFleet('{'), /не разобран/);
  assert.throws(() => parseFleet('[]'), /ожидался объект/);
  assert.throws(() => parseFleet('{"openAt":"x"}'), /нет profiles/);
  assert.throws(() => parseFleet('{"profiles":{"a":{}}}'), /нет openAt/);
  assert.throws(() => parseFleet('{"openAt":"x","profiles":{"bad name!":{}}}'), /недопустимое имя/);
  assert.throws(() => parseFleet('{"openAt":"x","profiles":{"a":1}}'), /должен быть объектом/);
});
