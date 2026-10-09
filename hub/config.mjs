// fleet.json → готовый Config профиля (FLEET-SPEC §9.1–9.2). Валидация — тем же кодом, что в расширении
// (hub/lib/shared.mjs собирается из src/shared/*.ts командой `node build.mjs --hub`).
import { readFileSync, watchFile, unwatchFile } from 'node:fs';
import { createHash } from 'node:crypto';
import { normalizeConfig, validateConfig } from './lib/shared.mjs';

/** Поля заказа, которые берутся из defaults/профиля (остальное — верхний уровень Config). */
const ORDER_KEYS = [
  'racersPerProfile', 'targets', 'stores', 'city', 'slot', 'payment', 'applePayFallback', 'cardFallback', 'applePayClick', 'applePayRetries',
  'allowApplePayExpress', 'contact', 'card', 'billing', 'autoReview', 'autoPlaceOrder', 'deliveryFallback', 'address',
];
/** Объекты, которые при переопределении профилем сливаются по ключам, а не заменяются целиком. */
const MERGE_KEYS = new Set(['slot', 'contact', 'card', 'billing', 'address', 'timing', 'proxy']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** defaults + профиль: вложенные объекты из MERGE_KEYS сливаются; `proxy: null` у профиля снимает прокси по умолчанию. */
export function mergeProfile(defaults = {}, profile = {}) {
  const out = { ...defaults };
  for (const [k, v] of Object.entries(profile)) {
    if (v === undefined) continue;
    if (MERGE_KEYS.has(k) && isObj(v) && isObj(out[k])) out[k] = { ...out[k], ...v };
    else out[k] = v;
  }
  return out;
}

export function fleetHash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** Разбор текста fleet.json. Возвращает { fleet, hash } или бросает ошибку с понятным текстом. */
export function parseFleet(text) {
  let fleet;
  try { fleet = JSON.parse(text); } catch (e) { throw new Error(`fleet.json не разобран: ${e.message}`); }
  if (!isObj(fleet)) throw new Error('fleet.json: ожидался объект');
  if (!isObj(fleet.profiles) || !Object.keys(fleet.profiles).length) throw new Error('fleet.json: нет profiles');
  if (!fleet.openAt) throw new Error('fleet.json: нет openAt');
  for (const [id, p] of Object.entries(fleet.profiles)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id)) throw new Error(`fleet.json: недопустимое имя профиля «${id}»`);
    if (!isObj(p)) throw new Error(`fleet.json: профиль ${id} должен быть объектом`);
  }
  return { fleet, hash: fleetHash(text) };
}

export const profileIds = (fleet) => Object.keys(fleet?.profiles ?? {});

/**
 * Готовый Config расширения для профиля: orders = [ { id: profileId, priority: 1, profiles: [profileId], …defaults, …profile } ].
 * null — профиль не описан. validation.errors непусто → хаб отвечает 422.
 */
export function buildProfileConfig(fleet, profileId, { hubUrl = '', version = 0, hash = '' } = {}) {
  const p = fleet?.profiles?.[profileId];
  if (!p) return null;
  const d = fleet.defaults ?? {};
  const m = mergeProfile(d, p);
  const order = { id: profileId, priority: 1, profiles: [profileId] };
  for (const k of ORDER_KEYS) if (m[k] !== undefined) order[k] = m[k];
  if (order.racersPerProfile === undefined) order.racersPerProfile = 1;
  const config = normalizeConfig({
    profileId,
    hubUrl: m.hubUrl ?? fleet.hubUrl ?? hubUrl,
    openAt: fleet.openAt,
    mode: m.mode ?? fleet.mode ?? 'auto',
    baseUrl: m.baseUrl ?? fleet.baseUrl,
    strategy: m.strategy ?? 'refresh',
    proxy: m.proxy ?? null,
    autoStart: m.autoStart === undefined ? true : !!m.autoStart,
    version,
    cfgHash: hash,
    ipCheckUrl: m.ipCheckUrl ?? fleet.ipCheckUrl,
    timing: { ...(fleet.timing ?? {}), ...(d.timing ?? {}), ...(p.timing ?? {}) },
    retries: fleet.retries,
    limits: fleet.limits,
    orders: [order],
  });
  return { config, validation: validateConfig(config) };
}

/** Все профили флота с результатом валидации — для дашборда. */
export function buildAll(fleet, opts) {
  const out = {};
  for (const id of profileIds(fleet)) out[id] = buildProfileConfig(fleet, id, opts);
  return out;
}

/**
 * Источник fleet.json: чтение, перечитывание по изменению файла (fs.watchFile, 2 с) и по запросу.
 * Ошибка разбора — старый конфиг остаётся, `error` для красной плашки на дашборде.
 * version: из файла; если файл изменился, а version не вырос — хаб поднимает её сам (расширения должны узнать об обновлении).
 */
export class FleetSource {
  constructor(file, { log = () => {} } = {}) {
    this.file = file;
    this.log = log;
    this.fleet = null;
    this.hash = '';
    this.version = 0;
    this.error = null;
    this.loadedAt = 0;
    this.listeners = new Set();
  }

  onChange(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }

  /** @returns {{ ok: boolean, changed: boolean, error?: string }} */
  load(reason = 'start') {
    let text;
    try { text = readFileSync(this.file, 'utf8'); } catch (e) {
      this.error = `fleet.json не прочитан (${this.file}): ${e.message}`;
      this.log(this.error, 'warn');
      return { ok: false, changed: false, error: this.error };
    }
    const hash = fleetHash(text);
    if (hash === this.hash && this.fleet) { this.error = null; return { ok: true, changed: false }; }
    let parsed;
    try { parsed = parseFleet(text); } catch (e) {
      this.error = e.message;
      this.log(`${e.message} — оставлен прежний конфиг v${this.version}`, 'warn');
      return { ok: false, changed: false, error: this.error };
    }
    const fileVersion = Math.max(0, Math.round(Number(parsed.fleet.version) || 0));
    let version = fileVersion;
    if (this.fleet && version <= this.version) {
      version = this.version + 1;
      this.log(`fleet.json изменился, но version (${fileVersion}) не увеличен — считаю его v${version}`, 'warn');
    }
    this.fleet = parsed.fleet;
    this.hash = hash;
    this.version = version;
    this.error = null;
    this.loadedAt = Date.now();
    const ids = profileIds(this.fleet);
    const bad = ids.filter((id) => buildProfileConfig(this.fleet, id, { version, hash }).validation.errors.length);
    this.log(`fleet.json v${version} · ${hash.slice(0, 8)} · профилей ${ids.length}${bad.length ? ` · с ошибками: ${bad.join(', ')}` : ''} (${reason})`, bad.length ? 'warn' : 'info');
    for (const cb of this.listeners) cb(this);
    return { ok: true, changed: true };
  }

  watch() {
    watchFile(this.file, { interval: 2000 }, () => this.load('fs.watch'));
  }

  unwatch() { unwatchFile(this.file); }

  config(profileId, hubUrl = '') {
    if (!this.fleet) return null;
    return buildProfileConfig(this.fleet, profileId, { hubUrl, version: this.version, hash: this.hash });
  }

  ids() { return profileIds(this.fleet); }
}
