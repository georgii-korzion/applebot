// Схема конфига (§10), значения по умолчанию и валидация.
import { PARTS, STORES, normPart } from './parts';

declare const __DEFAULT_BASE_URL__: string;
declare const __DEV__: boolean;

export const IS_DEV_BUILD = typeof __DEV__ !== 'undefined' && __DEV__;
export const LIVE_BASE = 'https://www.apple.com';

export function isMockBase(baseUrl: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(baseUrl.replace(/\/$/, ''));
}

export type PaymentMode = 'manual' | 'applepay';

export interface OrderCfg {
  id: string;
  priority: number;
  profiles: string[];
  racersPerProfile: number;
  targets: string[];
  stores: string[];
  city: string;
  slot: { day: string | null; after: string | null; before: string | null };
  payment: PaymentMode;
  applePayFallback: 'manual' | null;
  /** Оплата картой: если поля карты не появились за timing.cardWaitMs (блок карты у Apple подгружается с задержкой,
   *  live 30.09) — переключиться на Apple Pay; null — ждать и вводить самому. */
  cardFallback: 'applepay' | null;
  allowApplePayExpress: boolean;
  contact: { firstName: string; lastName: string; email: string; phone: string };
  /** Карта для автозаполнения (хранится в chrome.storage.local профиля открытым текстом; пусто — вводит человек). */
  card: { number: string; expiry: string; cvv: string; name: string };
  /** Адрес плательщика (Billing Address) — Apple требует его при оплате картой (18 Pro, live 30.09).
   *  Имя/фамилия пустые → из contact; street/area пустые → из address (доставка). */
  billing: { title: string; firstName: string; lastName: string; street: string; area: string; town: string; city: string };
  /** Нажимать «Review Your Order» самим, когда подошла очередь оплаты. */
  autoReview: boolean;
  /** Оплата картой (владелец, 30.09): нажать «Place Order» самим — один раз, без повторов; подтверждение банка (3-D Secure)
   *  в приложении — человек. Если банк подтверждения не запросит, заказ оформится сразу. Apple Pay это не касается. */
  autoPlaceOrder: boolean;
  deliveryFallback: boolean;
  address: { street: string; area: string; city: string };
}

export interface Timing {
  pollMs: number; preOpenReloadMs: number; postOpenReloadMs: number; minReloadMs: number;
  jitterPct: number; graceSec: number; atbTimeoutMs: number; atb404BackoffMs: number;
  atb404MaxInRow: number; holdLoserBagSec: number; manualPayTimeoutSec: number; assistAfterFailures: number;
  /** Рефреш закрытого магазина / пустой страницы до openAt − 60 с. */
  closedReloadMs: number;
  /** Сколько ждать, пока страница очереди Apple сама пустит дальше, прежде чем перезагрузить её. */
  queueMaxWaitSec: number;
  /** Ожидание гидратации страницы товара (есть разметка, но ещё нет формы покупки). */
  hydrateWaitMs: number;
  /** Повторы одного и того же действия чекаута при ошибке общего вида («unexpected error»). */
  checkoutErrorRetries: number;
  /** Ожидание полей карты на Billing после выбора «Credit or Debit Card» (блок подгружается с задержкой, live 30.09). */
  cardWaitMs: number;
}

export interface Config {
  profileId: string;
  hubUrl: string;
  openAt: string;
  mode: 'auto' | 'assist';
  orders: OrderCfg[];
  timing: Timing;
  retries: { checkout: number; slotsPerStore: number };
  limits: { maxTabsTotal: number };
  baseUrl: string;
}

export const DEFAULT_TIMING: Timing = {
  pollMs: 1200, preOpenReloadMs: 3000, postOpenReloadMs: 1500, minReloadMs: 1500,
  jitterPct: 30, graceSec: 20, atbTimeoutMs: 15000, atb404BackoffMs: 1500,
  atb404MaxInRow: 5, holdLoserBagSec: 90, manualPayTimeoutSec: 600, assistAfterFailures: 3,
  closedReloadMs: 30000, queueMaxWaitSec: 90, hydrateWaitMs: 12000, checkoutErrorRetries: 2, cardWaitMs: 10000,
};

export function defaultOrder(id = 'A'): OrderCfg {
  return {
    id,
    priority: 1,
    profiles: ['drop-1'],
    racersPerProfile: 3,
    targets: ['MK254AH/A', 'MK244AH/A'],
    stores: ['R597', 'R596', 'R706'],
    city: 'Dubai',
    slot: { day: null, after: null, before: null },
    payment: 'applepay',
    applePayFallback: 'manual',
    cardFallback: 'applepay',
    allowApplePayExpress: false,
    contact: { firstName: '', lastName: '', email: '', phone: '05XXXXXXXX' },
    card: { number: '', expiry: '', cvv: '', name: '' },
    billing: { title: '', firstName: '', lastName: '', street: '', area: '', town: '', city: 'Dubai' },
    autoPlaceOrder: false,
    autoReview: true,
    deliveryFallback: false,
    address: { street: '', area: '', city: 'Dubai' },
  };
}

export function defaultConfig(): Config {
  return {
    profileId: 'drop-1',
    hubUrl: '',
    openAt: '2026-10-16T16:00:00+04:00',
    mode: 'auto',
    orders: [defaultOrder('A')],
    timing: { ...DEFAULT_TIMING },
    retries: { checkout: 4, slotsPerStore: 4 },
    limits: { maxTabsTotal: 12 },
    baseUrl: typeof __DEFAULT_BASE_URL__ === 'string' ? __DEFAULT_BASE_URL__ : 'https://www.apple.com',
  };
}

function str(v: unknown, d = ''): string {
  return v === null || v === undefined ? d : String(v).trim();
}
function num(v: unknown, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function strOrNull(v: unknown): string | null {
  const s = str(v);
  return s ? s : null;
}

/** Приводит произвольный JSON к Config (заполняет дефолты, нормализует типы). */
export function normalizeConfig(raw: unknown): Config {
  const d = defaultConfig();
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const orders: OrderCfg[] = Array.isArray(r.orders) && r.orders.length
    ? r.orders.map((o: any, i: number) => {
      const od = defaultOrder(str(o?.id, String.fromCharCode(65 + i)));
      return {
        id: str(o?.id, od.id),
        priority: num(o?.priority, i + 1),
        profiles: Array.isArray(o?.profiles) ? o.profiles.map((x: unknown) => str(x)).filter(Boolean) : [],
        racersPerProfile: Math.max(1, Math.round(num(o?.racersPerProfile, od.racersPerProfile))),
        targets: Array.isArray(o?.targets) ? o.targets.map(normPart).filter(Boolean) : od.targets,
        stores: Array.isArray(o?.stores) ? o.stores.map((x: unknown) => str(x).toUpperCase()).filter(Boolean) : od.stores,
        city: str(o?.city, od.city),
        slot: {
          day: strOrNull(o?.slot?.day),
          after: strOrNull(o?.slot?.after),
          before: strOrNull(o?.slot?.before),
        },
        payment: o?.payment === 'manual' ? 'manual' : 'applepay',
        applePayFallback: o?.applePayFallback === null ? null : 'manual',
        cardFallback: o?.cardFallback === null ? null : 'applepay',
        allowApplePayExpress: !!o?.allowApplePayExpress,
        contact: {
          firstName: str(o?.contact?.firstName),
          lastName: str(o?.contact?.lastName),
          email: str(o?.contact?.email),
          phone: str(o?.contact?.phone).replace(/[\s-]/g, ''),
        },
        card: {
          number: str(o?.card?.number).replace(/[\s-]/g, ''),
          expiry: str(o?.card?.expiry),
          cvv: str(o?.card?.cvv),
          name: str(o?.card?.name),
        },
        billing: {
          title: str(o?.billing?.title),
          firstName: str(o?.billing?.firstName),
          lastName: str(o?.billing?.lastName),
          street: str(o?.billing?.street),
          area: str(o?.billing?.area),
          town: str(o?.billing?.town),
          city: str(o?.billing?.city, 'Dubai'),
        },
        autoReview: o?.autoReview === undefined ? true : !!o.autoReview,
        autoPlaceOrder: !!o?.autoPlaceOrder,
        deliveryFallback: !!o?.deliveryFallback,
        address: {
          street: str(o?.address?.street),
          area: str(o?.address?.area),
          city: str(o?.address?.city, 'Dubai'),
        },
      } satisfies OrderCfg;
    })
    : d.orders;
  const t = (r.timing ?? {}) as Record<string, unknown>;
  const timing = { ...DEFAULT_TIMING };
  for (const k of Object.keys(DEFAULT_TIMING) as (keyof Timing)[]) timing[k] = num(t[k], DEFAULT_TIMING[k]);
  return {
    profileId: str(r.profileId, d.profileId),
    hubUrl: str(r.hubUrl),
    openAt: str(r.openAt, d.openAt),
    mode: r.mode === 'assist' ? 'assist' : 'auto',
    orders,
    timing,
    retries: {
      checkout: num(r.retries?.checkout, d.retries.checkout),
      slotsPerStore: num(r.retries?.slotsPerStore, d.retries.slotsPerStore),
    },
    limits: { maxTabsTotal: num(r.limits?.maxTabsTotal, d.limits.maxTabsTotal) },
    baseUrl: str(r.baseUrl, d.baseUrl).replace(/\/$/, ''),
  };
}

export interface Validation { errors: string[]; warnings: string[] }

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Валидация при сохранении (§10). */
export function validateConfig(cfg: Config, now = Date.now()): Validation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!cfg.profileId) errors.push('profileId пуст');
  if (!cfg.orders.length) errors.push('нет ни одного заказа');
  const ids = new Set<string>();
  const profileUse = new Map<string, string[]>();
  let tabs = 0;
  for (const o of cfg.orders) {
    const p = `Заказ ${o.id}:`;
    if (ids.has(o.id)) errors.push(`${p} id повторяется`);
    ids.add(o.id);
    const c = o.contact;
    if (!c.firstName) errors.push(`${p} пустое имя`);
    if (!c.lastName) errors.push(`${p} пустая фамилия`);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(c.email)) errors.push(`${p} неверный email`);
    if (!/^05\d{8}$/.test(c.phone)) errors.push(`${p} телефон должен быть 05XXXXXXXX`);
    if (!o.targets.length) errors.push(`${p} нет targets`);
    for (const t of o.targets) if (!PARTS[t]) errors.push(`${p} неизвестный парт ${t}`);
    if (!o.stores.length) errors.push(`${p} нет stores`);
    for (const s of o.stores) if (!STORES.some((x) => x.id === s)) errors.push(`${p} магазин ${s} не из списка §2.2`);
    if (o.slot.after && !HHMM.test(o.slot.after)) errors.push(`${p} slot.after должен быть HH:MM`);
    if (o.slot.before && !HHMM.test(o.slot.before)) errors.push(`${p} slot.before должен быть HH:MM`);
    if (o.slot.day && !/^\d{1,2}$/.test(o.slot.day)) errors.push(`${p} slot.day — число месяца`);
    if (o.deliveryFallback && (!o.address.street || !o.address.area)) errors.push(`${p} deliveryFallback требует address.street и address.area`);
    if (o.card.number && !/^\d{13,19}$/.test(o.card.number)) errors.push(`${p} card.number — 13–19 цифр`);
    if (o.card.number && !luhn(o.card.number)) errors.push(`${p} card.number не проходит проверку контрольной цифры — опечатка?`);
    if (o.card.expiry && !/^(0[1-9]|1[0-2])\s?\/\s?(\d{2}|\d{4})$/.test(o.card.expiry)) errors.push(`${p} card.expiry — MM/YY`);
    if (o.card.cvv && !/^\d{3,4}$/.test(o.card.cvv)) errors.push(`${p} card.cvv — 3–4 цифры`);
    if (o.card.number && o.payment === 'manual') warnings.push(`${p} карта задана — хранится в этом профиле Chrome открытым текстом; после дропа удали её из настроек`);
    if (o.autoPlaceOrder && o.payment === 'manual') warnings.push(`${p} autoPlaceOrder — расширение нажмёт Place Order само (один раз); если банк не запросит подтверждение в приложении, заказ оформится без тебя`);
    if (o.autoPlaceOrder && !o.autoReview) warnings.push(`${p} autoPlaceOrder без autoReview — до Review дойти должен человек`);
    if (o.payment === 'manual' && !(o.billing.street || o.address.street) && !(o.billing.area || o.address.area)) warnings.push(`${p} оплата картой: Apple требует Billing Address (улица, Area, город) — заполни «Плательщик» в настройках, иначе Review не откроется`);
    if (o.racersPerProfile > 6) warnings.push(`${p} racersPerProfile=${o.racersPerProfile} — много вкладок в одном профиле`);
    for (const pr of o.profiles) profileUse.set(pr, [...(profileUse.get(pr) ?? []), o.id]);
    tabs += Math.max(1, o.profiles.length) * o.racersPerProfile;
  }
  for (const [pr, os] of profileUse) if (os.length > 1) errors.push(`профиль ${pr} назначен нескольким заказам: ${os.join(', ')}`);
  const mine = profileUse.get(cfg.profileId) ?? [];
  if (!mine.length && cfg.orders.length > 1) errors.push(`профиль ${cfg.profileId} не назначен ни одному заказу`);
  if (tabs > cfg.limits.maxTabsTotal) errors.push(`вкладок всего ${tabs} > limits.maxTabsTotal ${cfg.limits.maxTabsTotal}`);
  const openAt = Date.parse(cfg.openAt);
  if (!Number.isFinite(openAt)) errors.push('openAt — не дата ISO');
  else if (openAt <= now) warnings.push('openAt в прошлом — старт сразу в режиме «после открытия» (так и нужно для тестов на живом товаре)');
  if (cfg.timing.minReloadMs < 1500) errors.push('timing.minReloadMs < 1500 — не чаще раза в 1,5 с (§0)');
  if (cfg.timing.postOpenReloadMs < cfg.timing.minReloadMs) warnings.push('postOpenReloadMs < minReloadMs — будет поднят до minReloadMs');
  if (cfg.timing.pollMs < 1000) errors.push('timing.pollMs < 1000 — наблюдатель не чаще раза в секунду (§7.1)');
  if (cfg.timing.closedReloadMs < 5000) errors.push('timing.closedReloadMs < 5000 — закрытый магазин до старта не чаще раза в 5 с');
  if (cfg.timing.queueMaxWaitSec < 10) errors.push('timing.queueMaxWaitSec < 10 — страницу очереди Apple нельзя дёргать чаще');
  if (cfg.timing.cardWaitMs < 3000) errors.push('timing.cardWaitMs < 3000 — блок карты у Apple грузится несколько секунд');
  if (cfg.limits.maxTabsTotal > 12) warnings.push('maxTabsTotal > 12 — выше рекомендованного (§0)');
  if (!/^https?:\/\//.test(cfg.baseUrl)) errors.push('baseUrl должен начинаться с http(s)://');
  else if (!IS_DEV_BUILD && cfg.baseUrl !== LIVE_BASE) errors.push(`baseUrl «${cfg.baseUrl}» — боевая сборка работает только с ${LIVE_BASE}; мок-сервер только с dev-сборкой (папка extension-dev) в отдельном профиле`);
  else if (IS_DEV_BUILD && !isMockBase(cfg.baseUrl) && cfg.baseUrl !== LIVE_BASE) errors.push(`baseUrl «${cfg.baseUrl}»: либо ${LIVE_BASE}, либо адрес мока http://127.0.0.1:4777`);
  if (cfg.hubUrl && !/^wss?:\/\//.test(cfg.hubUrl)) errors.push('hubUrl должен начинаться с ws://');
  else if (cfg.hubUrl && !/^wss?:\/\/(127\.\d+\.\d+\.\d+|localhost|\[::1\])(:\d+)?\/?$/i.test(cfg.hubUrl)) warnings.push('хаб не на этом компьютере — сигналы координации пойдут по сети без шифрования; личные данные в хаб не отправляются, но лучше хаб на каждом компьютере свой (ws://127.0.0.1:8765)');
  return { errors, warnings };
}

function luhn(num: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = Number(num[i]);
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** Заказ, который ведёт этот профиль. */
export function orderFor(cfg: Config, profileId = cfg.profileId): OrderCfg | undefined {
  return cfg.orders.find((o) => o.profiles.includes(profileId)) ?? (cfg.orders.length === 1 ? cfg.orders[0] : undefined);
}

export type Phase = 'armed' | 'pre' | 'post';

/** Фаза дропа (§7.3): до openAt−60 с, последняя минута, после openAt или OPEN. */
export function phaseOf(cfg: Config, openedAt: number | undefined, now = Date.now()): Phase {
  const openAt = Date.parse(cfg.openAt);
  if (openedAt || !Number.isFinite(openAt) || now >= openAt) return 'post';
  return now >= openAt - 60_000 ? 'pre' : 'armed';
}

/**
 * Интервал рефреша, когда магазин закрыт / пустая страница / редирект с цели:
 * до openAt−60 с — closedReloadMs, последняя минута — preOpenReloadMs,
 * с openAt — postOpenReloadMs (без ожидания graceSec: закрытый магазин сам сигнал OPEN не даст).
 */
export function closedReloadMs(cfg: Config, openedAt: number | undefined, now = Date.now()): number {
  const t = cfg.timing;
  const ms = { armed: t.closedReloadMs, pre: t.preOpenReloadMs, post: t.postOpenReloadMs }[phaseOf(cfg, openedAt, now)];
  return Math.max(jitter(ms, t.jitterPct), t.minReloadMs);
}

export function jitter(ms: number, pct: number): number {
  return Math.round(ms * (1 + ((Math.random() * 2 - 1) * pct) / 100));
}

// Ключи chrome.storage
export const K = {
  config: 'config',
  profileId: 'profileId',
  modeOverride: 'modeOverride',
  prepared: 'prepared',
  log: 'log',
  order: 'order',
  tab: (id: number) => `tab:${id}`,
} as const;

/** Итоговый конфиг профиля из chrome.storage.local. */
export async function loadConfig(): Promise<Config> {
  const s = await chrome.storage.local.get([K.config, K.profileId, K.modeOverride]);
  const cfg = normalizeConfig(s[K.config]);
  if (s[K.profileId]) cfg.profileId = String(s[K.profileId]);
  const mo = s[K.modeOverride];
  if (mo === 'assist' || mo === 'auto') cfg.mode = mo;
  return cfg;
}
