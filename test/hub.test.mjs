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

// ---- таблица → fleet.json (hub/fleet-from-csv.mjs) ----
import { fleetFromRows, parseCsv, parseProxy } from '../hub/fleet-from-csv.mjs';

test('fleet-from-csv: разбор CSV — разделитель по заголовку, кавычки, CRLF, BOM', () => {
  const rows = parseCsv('﻿a;b;c\r\n1;"x;y";"he said ""hi"""\r\n\r\n2;;3\n');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1', 'x;y', 'he said "hi"'], ['2', '', '3']]);
  assert.deepEqual(parseCsv('a,b\n"1,5",2'), [['a', 'b'], ['1,5', '2']]);
  assert.deepEqual(parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
});

test('fleet-from-csv: прокси в одной ячейке → ProxyCfg, none → null, мусор → ошибка', () => {
  assert.deepEqual(parseProxy('http://u1:Qw7Zx-test-pass@proxy.example.com:8000'), { scheme: 'http', host: 'proxy.example.com', port: 8000, username: 'u1', password: 'Qw7Zx-test-pass' });
  assert.deepEqual(parseProxy('u1:p@10.0.0.5:3128'), { scheme: 'http', host: '10.0.0.5', port: 3128, username: 'u1', password: 'p' });
  assert.deepEqual(parseProxy('socks5://10.0.0.5:1080'), { scheme: 'socks5', host: '10.0.0.5', port: 1080 });
  assert.deepEqual(parseProxy('proxy.example.com:8000/'), { scheme: 'http', host: 'proxy.example.com', port: 8000 });
  assert.equal(parseProxy(''), null);
  assert.equal(parseProxy('none'), null);
  assert.equal(parseProxy(' - '), null);
  assert.throws(() => parseProxy('ftp://x'), /не разобран/);
  assert.throws(() => parseProxy('host without port'), /не разобран/);
});

test('fleet-from-csv: строки → профили: автонумерация по server, синонимы колонок, пусто = как в defaults, валидация хабом', () => {
  const base = fleet();
  const rows = [
    ['Сервер', 'Профиль', 'стратегия', 'Оплата', 'Имя', 'Фамилия', 'Email', 'Телефон', 'Карта', 'Срок', 'CVV', 'имя на карте', 'прокси', 'магазины', 'placeorder', 'комментарий', 'Левая колонка'],
    ['s1', '', 'hold', 'apple pay', 'Ahmed', 'Test', 'a@example.com', '050 123 4567', '', '', '', '', '', 'r597 r596', '', 'сам сканирует', 'x'],
    ['s1', '', '', 'карта', 'Maria', 'Test', 'm@example.com', '0529876543', '4111 1111 1111 1111', '12/29', '123', 'MARIA TEST', 'none', '', 'yes', '', ''],
    ['l1', 'l1-p07', 'refresh', '', 'Omar', 'Test', 'o@example.com', '0551112233', '', '', '', '', 'u:p@10.0.0.9:8000', 'R706', 'no', '', ''],
  ];
  const { fleet: f, warnings } = fleetFromRows(rows, base, { version: 9 });
  assert.deepEqual(Object.keys(f.profiles), ['s1-p01', 's1-p02', 'l1-p07']);
  assert.equal(f.version, 9);
  assert.equal(f.openAt, base.openAt, 'верх взят из базы');
  assert.deepEqual(f.defaults, base.defaults, 'defaults взяты из базы');
  const p1 = f.profiles['s1-p01'];
  assert.equal(p1.strategy, 'hold');
  assert.equal(p1.payment, 'applepay');
  assert.deepEqual(p1.contact, { firstName: 'Ahmed', lastName: 'Test', email: 'a@example.com', phone: '0501234567' }, 'телефон без пробелов');
  assert.deepEqual(p1.stores, ['R597', 'R596']);
  assert.equal('proxy' in p1, false, 'пустая ячейка прокси — наследует defaults');
  assert.equal('card' in p1, false);
  const p2 = f.profiles['s1-p02'];
  assert.equal(p2.payment, 'manual');
  assert.equal(p2.proxy, null, 'none → без прокси');
  assert.deepEqual(p2.card, { number: '4111111111111111', expiry: '12/29', cvv: '123', name: 'MARIA TEST' });
  assert.equal(p2.autoPlaceOrder, true);
  assert.equal('strategy' in p2, false);
  const p3 = f.profiles['l1-p07'];
  assert.deepEqual(p3.proxy, { scheme: 'http', host: '10.0.0.9', port: 8000, username: 'u', password: 'p' });
  assert.equal(p3.autoPlaceOrder, false);
  assert.ok(warnings.some((w) => /Левая колонка/.test(w)), `предупреждение о лишней колонке: ${warnings}`);
  const all = buildAll(f, { version: 9, hash: 'h' });
  for (const id of Object.keys(all)) assert.deepEqual(all[id].validation.errors, [], `${id}: ${all[id].validation.errors}`);
  assert.equal(all['s1-p01'].config.proxy.host, 'proxy.example.com', 'прокси из defaults базы');
  assert.equal(all['s1-p02'].config.orders[0].card.number, '4111111111111111');
  assert.equal(all['l1-p07'].config.strategy, 'refresh');
});

test('fleet-from-csv: понятные ошибки — дубль профиля, нет profile/server, плохая стратегия или оплата', () => {
  const base = fleet();
  const h = ['profile', 'firstName', 'lastName', 'email', 'phone', 'strategy', 'payment'];
  const row = (id, extra = {}) => [id, 'A', 'B', 'a@b.c', '0501234567', extra.strategy ?? '', extra.payment ?? ''];
  assert.throws(() => fleetFromRows([h, row('s1-p01'), row('s1-p01')], base), /дважды/);
  assert.throws(() => fleetFromRows([h, row('')], base), /нет ни profile, ни server/);
  assert.throws(() => fleetFromRows([h, row('s1-p01', { strategy: 'fast' })], base), /hold или refresh/);
  assert.throws(() => fleetFromRows([h, row('s1-p01', { payment: 'cash' })], base), /applepay или manual/);
  assert.throws(() => fleetFromRows([['note'], ['x']], base), /нужна колонка profile/);
  assert.throws(() => fleetFromRows([h], base), /ни одной строки/);
  const { warnings } = fleetFromRows([['profile'], ['s1-p01']], base);
  assert.ok(warnings.some((w) => /нет колонок контакта/.test(w)));
});
