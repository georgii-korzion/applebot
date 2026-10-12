// Таблица аккаунтов (CSV из Google Sheets / Excel) → fleet.json для хаба (FLEET-SPEC §9).
//   node hub/fleet-from-csv.mjs accounts.csv [--base fleet.example.json] [--out fleet.json] [--version 1] [--force]
// Берёт верх и defaults из --base (по умолчанию fleet.example.json рядом с репозиторием), профили — из таблицы.
// Пустая ячейка = «как в defaults». Потом обязательно: node hub/check.mjs fleet.json.
//
// Колонки (регистр и русские названия не важны, порядок любой; лишние колонки игнорируются с предупреждением):
//   profile | профиль      имя профиля s1-p01 (если пусто — server + порядковый номер в этом сервере)
//   server  | сервер       префикс сервера (s1, l2) — для автонумерации p01, p02, …
//   strategy| стратегия    hold / refresh
//   payment | оплата       applepay / manual (синонимы: card, карта → manual; apple, applepay, ap → applepay)
//   firstName lastName email phone | имя фамилия email телефон
//   card expiry cvv cardName | карта срок cvv имя_на_карте
//   billingTitle billingFirstName billingLastName billingStreet billingArea billingTown billingCity
//           | обращение улица район город_оплаты   (billingCity: город плательщика)
//   proxy   | прокси       http://user:pass@host:port, user:pass@host:port, host:port, socks5://…; «none»/«-» = без прокси
//   targets | цели         MJR54AH/A, MJX54AH/A (через запятую, пробел или |)
//   stores  | магазины     R597 R596
//   city    | город        Dubai / Abu Dhabi (город самовывоза)
//   slotDay slotAfter slotBefore | день после до      окно самовывоза
//   autoPlaceOrder | placeorder   yes/no — жать Place Order самим (карта)
//   cardFallback   applepay / none;  applePayClick  debugger / dom;  autoStart  yes/no
//   note | комментарий     игнорируется
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAll, profileIds } from './config.mjs';

const ALIASES = {
  profile: ['profile', 'профиль', 'id', 'profileid'],
  server: ['server', 'сервер', 'machine', 'машина', 'prefix'],
  strategy: ['strategy', 'стратегия'],
  payment: ['payment', 'оплата', 'способ оплаты', 'способоплаты'],
  firstName: ['firstname', 'first name', 'имя', 'name'],
  lastName: ['lastname', 'last name', 'фамилия', 'surname'],
  email: ['email', 'e-mail', 'почта', 'mail'],
  phone: ['phone', 'телефон', 'tel', 'mobile'],
  card: ['card', 'карта', 'cardnumber', 'card number', 'номер карты', 'номеркарты', 'pan'],
  expiry: ['expiry', 'exp', 'срок', 'expires', 'mm/yy', 'expdate'],
  cvv: ['cvv', 'cvc', 'cvv2', 'код'],
  cardName: ['cardname', 'card name', 'имя на карте', 'имянакарте', 'holder', 'cardholder'],
  billingTitle: ['billingtitle', 'title', 'обращение'],
  billingFirstName: ['billingfirstname', 'имя плательщика', 'имяплательщика'],
  billingLastName: ['billinglastname', 'фамилия плательщика', 'фамилияплательщика'],
  billingStreet: ['billingstreet', 'street', 'улица', 'адрес', 'address'],
  billingArea: ['billingarea', 'area', 'район'],
  billingTown: ['billingtown', 'town'],
  billingCity: ['billingcity', 'город плательщика', 'городплательщика', 'город оплаты', 'городоплаты'],
  proxy: ['proxy', 'прокси'],
  targets: ['targets', 'target', 'цели', 'цель', 'model', 'модель', 'sku'],
  stores: ['stores', 'store', 'магазины', 'магазин'],
  city: ['city', 'город', 'город самовывоза', 'городсамовывоза', 'pickup city', 'pickupcity'],
  slotDay: ['slotday', 'день', 'day'],
  slotAfter: ['slotafter', 'после', 'after'],
  slotBefore: ['slotbefore', 'до', 'before'],
  autoPlaceOrder: ['autoplaceorder', 'placeorder', 'place order', 'сам place order', 'auto place order'],
  cardFallback: ['cardfallback'],
  applePayClick: ['applepayclick'],
  autoStart: ['autostart', 'автостарт'],
  note: ['note', 'notes', 'комментарий', 'коммент', 'comment', 'примечание', 'кто', 'owner'],
};
const BY_ALIAS = new Map();
for (const [key, list] of Object.entries(ALIASES)) for (const a of list) BY_ALIAS.set(a, key);
const norm = (s) => String(s ?? '').replace(/^﻿/, '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Разбор CSV/TSV: разделитель по первой строке (`;` `,` `\t`), кавычки по RFC 4180, CRLF. Возвращает массив строк-массивов. */
export function parseCsv(text) {
  const src = String(text).replace(/^﻿/, '');
  const head = src.split(/\r?\n/, 1)[0] ?? '';
  const counts = { ';': 0, ',': 0, '\t': 0 };
  let inQ = false;
  for (const ch of head) { if (ch === '"') inQ = !inQ; else if (!inQ && ch in counts) counts[ch]++; }
  const sep = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
      continue;
    }
    if (ch === '"') { q = true; continue; }
    if (ch === sep) { row.push(cell); cell = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const list = (v) => String(v).split(/[,|;\s]+/).map((s) => s.trim()).filter(Boolean);
const yes = (v) => /^(1|y|yes|true|да|on|\+)$/i.test(String(v).trim());
const no = (v) => /^(0|n|no|false|нет|off|-)$/i.test(String(v).trim());

/** «http://user:pass@host:port» | «user:pass@host:port» | «host:port» | «none» → ProxyCfg | null; бросает при мусоре. */
export function parseProxy(v) {
  const s = String(v).trim();
  if (!s || /^(none|no|нет|-|direct|напрямую)$/i.test(s)) return null;
  const m = /^(?:(https?|socks5?):\/\/)?(?:([^:@/\s]+)(?::([^@/\s]*))?@)?([A-Za-z0-9._-]+):(\d{2,5})\/?$/.exec(s);
  if (!m) throw new Error(`прокси не разобран: «${s}» (ожидается http://user:pass@host:port или host:port)`);
  const scheme = (m[1] ?? 'http').replace(/^https$/, 'http').replace(/^socks$/, 'socks5');
  const p = { scheme, host: m[4], port: Number(m[5]) };
  if (m[2]) { p.username = decodeURIComponent(m[2]); p.password = decodeURIComponent(m[3] ?? ''); }
  return p;
}

function paymentOf(v) {
  const s = norm(v);
  if (!s) return undefined;
  if (/^(applepay|apple pay|apple|ap)$/.test(s)) return 'applepay';
  if (/^(manual|card|карта|картой|cc)$/.test(s)) return 'manual';
  throw new Error(`оплата «${v}»: applepay или manual`);
}

/**
 * Строки таблицы → fleet.json. rows[0] — заголовок. base — fleet.json, у которого берутся верх и defaults.
 * @returns {{ fleet: object, warnings: string[] }}
 */
export function fleetFromRows(rows, base, { version } = {}) {
  if (!rows.length) throw new Error('таблица пуста');
  const header = rows[0].map(norm);
  const cols = header.map((h) => (h ? BY_ALIAS.get(h) ?? BY_ALIAS.get(h.replace(/[\s_-]+/g, '')) ?? null : null));
  const warnings = [];
  header.forEach((h, i) => { if (h && !cols[i]) warnings.push(`колонка «${rows[0][i].trim()}» не известна — пропущена`); });
  if (!cols.includes('profile') && !cols.includes('server')) throw new Error('нужна колонка profile (s1-p01) или server (s1) для автонумерации');
  if (!cols.includes('firstName') || !cols.includes('lastName') || !cols.includes('email') || !cols.includes('phone')) {
    warnings.push('нет колонок контакта (firstName lastName email phone) — профили без контакта хаб отвергнет (422)');
  }
  const { profiles: _drop, ...top } = base ?? {};
  const fleet = { ...top, profiles: {} };
  if (version !== undefined) fleet.version = version;
  if (!fleet.defaults) fleet.defaults = {};
  const perServer = new Map();
  const seen = new Set();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const get = (key) => { const i = cols.indexOf(key); return i < 0 ? '' : String(row[i] ?? '').trim(); };
    const where = `строка ${r + 1}`;
    let id = get('profile');
    const server = get('server');
    if (!id) {
      if (!server) throw new Error(`${where}: нет ни profile, ни server`);
      const n = (perServer.get(server) ?? 0) + 1;
      perServer.set(server, n);
      id = `${server}-p${String(n).padStart(2, '0')}`;
    } else if (server && !id.startsWith(`${server}-`)) warnings.push(`${where}: profile «${id}» не начинается с server «${server}»`);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id)) throw new Error(`${where}: недопустимое имя профиля «${id}»`);
    if (seen.has(id)) throw new Error(`${where}: профиль «${id}» встречается дважды`);
    seen.add(id);
    const p = {};
    const strategy = norm(get('strategy'));
    if (strategy) { if (!/^(hold|refresh)$/.test(strategy)) throw new Error(`${where}: стратегия «${get('strategy')}»: hold или refresh`); p.strategy = strategy; }
    try {
      const pay = paymentOf(get('payment'));
      if (pay) p.payment = pay;
    } catch (e) { throw new Error(`${where}: ${e.message}`); }
    const contact = {};
    for (const k of ['firstName', 'lastName', 'email', 'phone']) { const v = get(k); if (v) contact[k] = k === 'phone' ? v.replace(/[\s-]/g, '') : v; }
    if (Object.keys(contact).length) p.contact = contact;
    const card = {};
    const cardMap = { card: 'number', expiry: 'expiry', cvv: 'cvv', cardName: 'name' };
    for (const [col, k] of Object.entries(cardMap)) { const v = get(col); if (v) card[k] = k === 'number' ? v.replace(/[\s-]/g, '') : v; }
    if (Object.keys(card).length) p.card = card;
    const billing = {};
    const billMap = { billingTitle: 'title', billingFirstName: 'firstName', billingLastName: 'lastName', billingStreet: 'street', billingArea: 'area', billingTown: 'town', billingCity: 'city' };
    for (const [col, k] of Object.entries(billMap)) { const v = get(col); if (v) billing[k] = v; }
    if (Object.keys(billing).length) p.billing = billing;
    if (cols.includes('proxy')) {
      const raw = get('proxy');
      if (raw) { try { p.proxy = parseProxy(raw); } catch (e) { throw new Error(`${where}: ${e.message}`); } }
    }
    if (get('targets')) p.targets = list(get('targets'));
    if (get('stores')) p.stores = list(get('stores')).map((s) => s.toUpperCase());
    if (get('city')) p.city = get('city');
    const slot = {};
    for (const [col, k] of Object.entries({ slotDay: 'day', slotAfter: 'after', slotBefore: 'before' })) { const v = get(col); if (v) slot[k] = v; }
    if (Object.keys(slot).length) p.slot = slot;
    for (const k of ['autoPlaceOrder', 'autoStart']) {
      const v = get(k);
      if (!v) continue;
      if (yes(v)) p[k] = true; else if (no(v)) p[k] = false; else throw new Error(`${where}: ${k} «${v}»: yes/no`);
    }
    const cf = norm(get('cardFallback'));
    if (cf) { if (cf === 'applepay') p.cardFallback = 'applepay'; else if (/^(none|no|нет|-|null)$/.test(cf)) p.cardFallback = null; else throw new Error(`${where}: cardFallback «${get('cardFallback')}»: applepay или none`); }
    const apc = norm(get('applePayClick'));
    if (apc) { if (!/^(debugger|dom)$/.test(apc)) throw new Error(`${where}: applePayClick «${get('applePayClick')}»: debugger или dom`); p.applePayClick = apc; }
    if (p.payment === 'manual' && !card.number && !(fleet.defaults.card && fleet.defaults.card.number)) warnings.push(`${id}: оплата картой, а номер карты пуст`);
    fleet.profiles[id] = p;
  }
  if (!Object.keys(fleet.profiles).length) throw new Error('в таблице нет ни одной строки с профилем');
  return { fleet, warnings };
}

function main() {
  const args = process.argv.slice(2);
  const opt = { base: '', out: 'fleet.json', version: undefined, force: false };
  let input = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--base') opt.base = args[++i];
    else if (a === '--out') opt.out = args[++i];
    else if (a === '--version') opt.version = Number(args[++i]);
    else if (a === '--force') opt.force = true;
    else if (a === '-h' || a === '--help' || a.startsWith('-')) { console.log('node hub/fleet-from-csv.mjs accounts.csv [--base fleet.example.json] [--out fleet.json] [--version N] [--force]'); process.exit(a.startsWith('-') && a !== '-h' && a !== '--help' ? 1 : 0); }
    else input = a;
  }
  if (!input) { console.error('нужен путь к CSV: node hub/fleet-from-csv.mjs accounts.csv'); process.exit(1); }
  // база по умолчанию: fleet.example.json рядом со скриптом (архив установки) или в корне репозитория
  const here = resolve(fileURLToPath(import.meta.url), '..');
  const baseFile = resolve(opt.base || [resolve(here, 'fleet.example.json'), resolve(here, '..', 'fleet.example.json')].find((f) => existsSync(f)) || 'fleet.example.json');
  const outFile = resolve(opt.out);
  if (existsSync(outFile) && !opt.force) { console.error(`${outFile} уже есть — укажи --out другой или --force (перезаписать)`); process.exit(1); }
  let base;
  try { base = JSON.parse(readFileSync(baseFile, 'utf8')); } catch (e) { console.error(`база ${baseFile} не прочитана: ${e.message}`); process.exit(1); }
  let rows;
  try { rows = parseCsv(readFileSync(resolve(input), 'utf8')); } catch (e) { console.error(`CSV не прочитан: ${e.message}`); process.exit(1); }
  let res;
  try { res = fleetFromRows(rows, base, { version: Number.isFinite(opt.version) ? opt.version : undefined }); } catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
  const { fleet, warnings } = res;
  const text = `${JSON.stringify(fleet, null, 2)}\n`;
  writeFileSync(outFile, text);
  const all = buildAll(fleet, { version: Number(fleet.version) || 0, hash: 'csv' });
  const ids = profileIds(fleet);
  const bad = ids.filter((id) => all[id].validation.errors.length);
  const byServer = new Map();
  for (const id of ids) { const s = id.includes('-') ? id.slice(0, id.indexOf('-')) : id; byServer.set(s, (byServer.get(s) ?? 0) + 1); }
  console.log(`${outFile}: профилей ${ids.length} (${[...byServer].map(([s, n]) => `${s}×${n}`).join(', ')}) · база ${baseFile} · version ${fleet.version ?? '—'}`);
  for (const w of warnings) console.log(`  ! ${w}`);
  for (const id of bad) for (const e of all[id].validation.errors) console.log(`  ✗ ${id}: ${e}`);
  console.log(bad.length ? `\nОШИБКИ у ${bad.length} профилей — исправь таблицу и повтори (или правь ${outFile} руками)` : `\nвсё в порядке; дальше: node hub/check.mjs ${opt.out}`);
  process.exit(bad.length ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
