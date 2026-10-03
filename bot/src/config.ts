// Конфиг бота и секреты (BOT-SPEC §5): JSONC, значения по умолчанию, проверки, перевод в конфиг расширения.
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { DEFAULT_TIMING, luhn, timingErrors, type Config, type OrderCfg, type Timing } from '../../src/shared/config';
import { defaultBotRuntime, type BotRuntime, type Strategy } from '../../src/shared/bot';
import { PARTS, STORES, normPart } from '../../src/shared/parts';

export type PayMethod = 'card' | 'applepay';

export interface BotOrder {
  id: string;
  priority: number;
  targets: string[];
  stores: string[];
  city: string;
  slot: { day: string | null; after: string | null; before: string | null };
  recipient: string;
  payment: PayMethod;
  deliveryFallback: boolean;
  address: { street: string; area: string; city: string };
  /** Поля карты не появились на Billing → Apple Pay (как в расширении); null — ждать человека. */
  cardFallback: 'applepay' | null;
}

export interface BotConfig {
  /** Имя этой машины (несколько Mac работают независимо). */
  machine: string;
  openAt: string;
  baseUrl: string;
  runtimeDir: string;
  hub: { port: number };
  fleet: {
    browsers: number;
    launchStaggerMs: number;
    strategyMix: { refresh: number; hold: number };
    adaptive: boolean;
    /** Окна адаптации H1: через N с после первого ADMITTED и ещё через M с (§7). */
    adaptiveWindowsSec: [number, number];
    holdMaxWaitSec: number;
    claimersPerOrder: number;
    cdp: boolean;
    cdpBasePort: number;
    chromePath: string;
    headless: boolean;
    /** Сборка расширения, которую копирует лаунчер: dist (боевая) или dist-dev (мок). */
    extensionDir: string;
    window: { width: number; height: number };
    screen: { width: number; height: number } | null;
    extraArgs: string[];
    mockKeychain: boolean;
    /** Задержка 0–500 мс после OPEN: half — половине флота (§20.5), all, none. */
    openJitter: 'half' | 'all' | 'none';
    warmupSec: number;
    directAtb: boolean;
    blockHeavy: boolean;
    snapshots: boolean;
  };
  proxies: {
    mode: 'off' | 'all' | 'mixed';
    directBrowsers: number;
    maxBrowsersPerProxy: number;
    requireCountry: string;
    relaunchOnBlock: boolean;
    basePort: number;
    /** Куда стучаться для проверки живости прокси (host:port). */
    probe: string;
    downAfterSec: number;
    /** false — трафик на 127.0.0.1 тоже через прокси (только для тестов). */
    bypassLoopback: boolean;
  };
  orders: BotOrder[];
  payment: {
    stopBeforePay: boolean;
    card: { parallelPerCard: number; threeDsTimeoutSec: number; burnAfterDeclines: number; burnOn3dsTimeout: boolean };
    applePay: { cdpClick: boolean; osClick: boolean; timeoutSec: number; reopenTries: number; sendQrScreenshot: boolean; fullscreen: boolean };
  };
  notify: {
    telegram: { enabled: boolean; liveStatus: boolean; statusEditMs: number; apiBase: string };
    webhooks: { enabled: boolean; events: string[] };
    /** Все заказы и события человеку — в текстовый файл (владелец, 03.10). */
    file: { enabled: boolean; path: string };
    fullContact: boolean;
    summaryAfterMin: number;
  };
  privacy: { maskContactsInLogs: boolean; maskCardInLogs: boolean; logTokens: boolean };
  watchdog: { enabled: boolean; checkMs: number; thresholds: Record<string, number> };
  timing: Timing;
  bench: { runs: number; browsers: number[]; targets: string[] };
}

export interface Recipient { firstName: string; lastName: string; email: string; phone: string }
export interface CardBilling { title: string; firstName: string; lastName: string; street: string; area: string; town: string; city: string }
export interface CardDef {
  id: string; label: string; role: 'primary' | 'reserve';
  number: string; expiry: string; cvv: string; name: string;
  billing: CardBilling;
  maxOrders: number;
}
export interface ProxyDef { id: string; label: string; url: string }
export interface Secrets {
  recipients: Record<string, Recipient>;
  cards: CardDef[];
  proxies: ProxyDef[];
  telegram: { botToken: string; chatId: string; allowedUserIds: number[] };
  webhooks: { url: string; secret: string }[];
}

export const DEFAULT_THRESHOLDS: Record<string, number> = {
  ATB_PENDING: 20, IN_BAG: 20, CHECKOUT: 20, GUEST: 20, FULFILLMENT: 40, CONTACT: 25, BILLING: 30, REVIEW: 20,
};

/** Состояния ожидания — сторож их не трогает (§10). */
export const WAIT_STATES = new Set(['ARMED', 'PRE_RELOAD', 'WATCHING', 'FAST_RELOAD', 'CLOSED', 'QUEUE', 'BUSY', 'SPARE', 'STANDBY', 'PAY_QUEUE', 'HOLD', 'ADMITTED', 'IDLE', 'INIT', 'STOPPED', 'ORDERED', 'MANUAL', 'WARMUP']);

// ---------- JSONC ----------
/** JSON с комментариями и висячими запятыми. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const ch = text[i];
    if (inStr) {
      out += ch;
      if (ch === '\\') { out += text[i + 1] ?? ''; i += 2; continue; }
      if (ch === '"') inStr = false;
      i++;
      continue;
    }
    if (ch === '"') { inStr = true; out += ch; i++; continue; }
    if (ch === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (ch === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; continue; }
    out += ch;
    i++;
  }
  // висячие запятые вне строк
  let res = '';
  inStr = false;
  for (let j = 0; j < out.length; j++) {
    const ch = out[j];
    if (inStr) { res += ch; if (ch === '\\') { res += out[++j] ?? ''; } else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; res += ch; continue; }
    if (ch === ',') {
      let k = j + 1;
      while (k < out.length && /\s/.test(out[k])) k++;
      if (out[k] === '}' || out[k] === ']') continue;
    }
    res += ch;
  }
  return JSON.parse(res);
}

export function readJsonc(path: string): unknown {
  return parseJsonc(readFileSync(path, 'utf8'));
}

// ---------- нормализация ----------
const str = (v: unknown, d = '') => (v === null || v === undefined ? d : String(v).trim());
const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : d);
const bool = (v: unknown, d: boolean) => (v === undefined || v === null ? d : !!v);
const strOrNull = (v: unknown) => { const s = str(v); return s ? s : null; };
const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' ? (v as Record<string, any>) : {});

export function normalizeBotConfig(raw: unknown): BotConfig {
  const r = obj(raw);
  const f = obj(r.fleet);
  const p = obj(r.proxies);
  const pay = obj(r.payment);
  const n = obj(r.notify);
  const pr = obj(r.privacy);
  const w = obj(r.watchdog);
  const t = obj(r.timing);
  const timing = { ...DEFAULT_TIMING };
  for (const k of Object.keys(DEFAULT_TIMING) as (keyof Timing)[]) timing[k] = num(t[k], DEFAULT_TIMING[k]);
  const mix = obj(f.strategyMix);
  const orders: BotOrder[] = (Array.isArray(r.orders) ? r.orders : []).map((o: any, i: number) => ({
    id: str(o?.id, String.fromCharCode(65 + i)),
    priority: num(o?.priority, i + 1),
    targets: Array.isArray(o?.targets) ? o.targets.map(normPart).filter(Boolean) : [],
    stores: Array.isArray(o?.stores) ? o.stores.map((x: unknown) => str(x).toUpperCase()).filter(Boolean) : ['R597', 'R596', 'R706'],
    city: str(o?.city, 'Dubai'),
    slot: { day: strOrNull(o?.slot?.day), after: strOrNull(o?.slot?.after), before: strOrNull(o?.slot?.before) },
    recipient: str(o?.recipient),
    payment: o?.payment === 'applepay' ? 'applepay' : 'card',
    deliveryFallback: !!o?.deliveryFallback,
    address: { street: str(o?.address?.street), area: str(o?.address?.area), city: str(o?.address?.city, 'Dubai') },
    cardFallback: o?.cardFallback === null ? null : 'applepay',
  }));
  const thresholds = { ...DEFAULT_THRESHOLDS };
  for (const [k, v] of Object.entries(obj(w.thresholds))) thresholds[k] = num(v, thresholds[k] ?? 30);
  const aw = Array.isArray(f.adaptiveWindowsSec) ? f.adaptiveWindowsSec : [45, 30];
  return {
    machine: str(r.machine, hostname().split('.')[0] || 'mac'),
    openAt: str(r.openAt, '2026-10-16T16:00:00+04:00'),
    baseUrl: str(r.baseUrl, 'https://www.apple.com').replace(/\/$/, ''),
    runtimeDir: str(r.runtimeDir, 'runtime'),
    hub: { port: num(obj(r.hub).port, 8765) },
    fleet: {
      browsers: Math.max(1, Math.round(num(f.browsers, 20))),
      launchStaggerMs: num(f.launchStaggerMs, 1500),
      strategyMix: { refresh: num(mix.refresh, 0.5), hold: num(mix.hold, 0.5) },
      adaptive: bool(f.adaptive, true),
      adaptiveWindowsSec: [num(aw[0], 45), num(aw[1], 30)],
      holdMaxWaitSec: num(f.holdMaxWaitSec, 300),
      claimersPerOrder: Math.max(1, Math.round(num(f.claimersPerOrder, 2))),
      cdp: bool(f.cdp, true),
      cdpBasePort: num(f.cdpBasePort, 9301),
      chromePath: str(f.chromePath),
      headless: bool(f.headless, false),
      extensionDir: str(f.extensionDir, 'dist'),
      window: { width: num(f.window?.width, 900), height: num(f.window?.height, 800) },
      screen: f.screen ? { width: num(f.screen.width, 1728), height: num(f.screen.height, 1117) } : null,
      extraArgs: Array.isArray(f.extraArgs) ? f.extraArgs.map(String) : [],
      mockKeychain: bool(f.mockKeychain, true),
      openJitter: f.openJitter === 'all' || f.openJitter === 'none' ? f.openJitter : 'half',
      warmupSec: num(f.warmupSec, 150),
      directAtb: bool(f.directAtb, false),
      blockHeavy: bool(f.blockHeavy, false),
      snapshots: bool(f.snapshots, true),
    },
    proxies: {
      mode: p.mode === 'all' || p.mode === 'off' ? p.mode : 'mixed',
      directBrowsers: Math.max(0, Math.round(num(p.directBrowsers, 4))),
      maxBrowsersPerProxy: Math.max(1, Math.round(num(p.maxBrowsersPerProxy, 1))),
      requireCountry: str(p.requireCountry, 'AE').toUpperCase(),
      relaunchOnBlock: bool(p.relaunchOnBlock, true),
      basePort: num(p.basePort, 18801),
      probe: str(p.probe, 'www.apple.com:443'),
      downAfterSec: num(p.downAfterSec, 10),
      bypassLoopback: bool(p.bypassLoopback, true),
    },
    orders,
    payment: {
      stopBeforePay: bool(pay.stopBeforePay, false),
      card: {
        parallelPerCard: Math.max(1, num(pay.card?.parallelPerCard, 1)),
        threeDsTimeoutSec: num(pay.card?.threeDsTimeoutSec, 300),
        burnAfterDeclines: Math.max(1, num(pay.card?.burnAfterDeclines, 1)),
        burnOn3dsTimeout: bool(pay.card?.burnOn3dsTimeout, false),
      },
      applePay: {
        cdpClick: bool(pay.applePay?.cdpClick, true),
        osClick: bool(pay.applePay?.osClick, false),
        timeoutSec: num(pay.applePay?.timeoutSec, 300),
        reopenTries: num(pay.applePay?.reopenTries, 3),
        // владелец (03.10): QR у Apple Pay меняется — в Telegram не шлём, окно на весь экран
        sendQrScreenshot: bool(pay.applePay?.sendQrScreenshot, false),
        fullscreen: bool(pay.applePay?.fullscreen, true),
      },
    },
    notify: {
      telegram: {
        enabled: bool(n.telegram?.enabled, false), liveStatus: bool(n.telegram?.liveStatus, true),
        statusEditMs: Math.max(3000, num(n.telegram?.statusEditMs, 3000)), apiBase: str(n.telegram?.apiBase, 'https://api.telegram.org').replace(/\/$/, ''),
      },
      webhooks: { enabled: bool(n.webhooks?.enabled, false), events: Array.isArray(n.webhooks?.events) ? n.webhooks.events.map(String) : [] },
      file: { enabled: bool(n.file?.enabled, true), path: str(n.file?.path, 'orders.txt') },
      fullContact: bool(n.fullContact, true),
      summaryAfterMin: num(n.summaryAfterMin, 30),
    },
    privacy: {
      maskContactsInLogs: bool(pr.maskContactsInLogs, false),
      maskCardInLogs: bool(pr.maskCardInLogs, true),
      logTokens: bool(pr.logTokens, false),
    },
    watchdog: { enabled: bool(w.enabled, true), checkMs: num(w.checkMs, 1000), thresholds },
    timing,
    bench: {
      runs: num(obj(r.bench).runs, 5),
      browsers: Array.isArray(obj(r.bench).browsers) ? obj(r.bench).browsers.map(Number) : [1, 10, 20],
      targets: Array.isArray(obj(r.bench).targets) ? obj(r.bench).targets.map(normPart) : ['MJR54AH/A'],
    },
  };
}

export function normalizeSecrets(raw: unknown): Secrets {
  const r = obj(raw);
  const recipients: Record<string, Recipient> = {};
  for (const [k, v] of Object.entries(obj(r.recipients))) {
    const x = obj(v);
    recipients[k] = { firstName: str(x.firstName), lastName: str(x.lastName), email: str(x.email), phone: str(x.phone).replace(/[\s-]/g, '') };
  }
  const cards: CardDef[] = (Array.isArray(r.cards) ? r.cards : []).map((c: any, i: number) => ({
    id: str(c?.id, `c${i + 1}`),
    label: str(c?.label, `Карта ${i + 1}`),
    role: c?.role === 'reserve' ? 'reserve' : 'primary',
    number: str(c?.number).replace(/[\s-]/g, ''),
    expiry: str(c?.expiry),
    cvv: str(c?.cvv),
    name: str(c?.name),
    billing: {
      title: str(c?.billing?.title), firstName: str(c?.billing?.firstName), lastName: str(c?.billing?.lastName),
      street: str(c?.billing?.street), area: str(c?.billing?.area), town: str(c?.billing?.town), city: str(c?.billing?.city, 'Dubai'),
    },
    maxOrders: Math.max(1, Math.round(num(c?.maxOrders, 2))),
  }));
  const proxies: ProxyDef[] = (Array.isArray(r.proxies) ? r.proxies : []).map((p: any, i: number) => ({
    id: str(p?.id, `px${i + 1}`), label: str(p?.label, `px${i + 1}`), url: str(p?.url),
  })).filter((p: ProxyDef) => p.url);
  const tg = obj(r.telegram);
  return {
    recipients, cards, proxies,
    telegram: { botToken: str(tg.botToken), chatId: str(tg.chatId), allowedUserIds: Array.isArray(tg.allowedUserIds) ? tg.allowedUserIds.map(Number).filter(Number.isFinite) : [] },
    webhooks: (Array.isArray(r.webhooks) ? r.webhooks : []).map((w: any) => ({ url: str(w?.url), secret: str(w?.secret) })).filter((w: { url: string }) => w.url),
  };
}

// ---------- проверки §5 ----------
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const PHONE_RE = /^05\d{8}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateBot(cfg: BotConfig, sec: Secrets, opts: { devBuild?: boolean; now?: number } = {}): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const now = opts.now ?? Date.now();
  if (!cfg.orders.length) errors.push('нет ни одного заказа (orders)');
  const ids = new Set<string>();
  const recUse = new Map<string, string>();
  let cardOrders = 0;
  for (const o of cfg.orders) {
    const p = `Заказ ${o.id}:`;
    if (ids.has(o.id)) errors.push(`${p} id повторяется`);
    ids.add(o.id);
    if (!o.targets.length) errors.push(`${p} нет targets`);
    for (const t of o.targets) if (!PARTS[t]) errors.push(`${p} неизвестный парт ${t}`);
    if (!o.stores.length) errors.push(`${p} нет stores`);
    for (const s of o.stores) if (!STORES.some((x) => x.id === s)) errors.push(`${p} магазин ${s} не из списка ОАЭ`);
    if (o.slot.after && !HHMM.test(o.slot.after)) errors.push(`${p} slot.after должен быть HH:MM`);
    if (o.slot.before && !HHMM.test(o.slot.before)) errors.push(`${p} slot.before должен быть HH:MM`);
    if (o.slot.day && !/^\d{1,2}$/.test(o.slot.day)) errors.push(`${p} slot.day — число месяца`);
    if (o.deliveryFallback && (!o.address.street || !o.address.area)) errors.push(`${p} deliveryFallback требует address.street и address.area`);
    const r = sec.recipients[o.recipient];
    if (!o.recipient) errors.push(`${p} не указан recipient`);
    else if (!r) errors.push(`${p} получателя «${o.recipient}» нет в secrets.recipients`);
    else {
      if (!r.firstName) errors.push(`${p} у получателя ${o.recipient} пустое имя`);
      if (!r.lastName) errors.push(`${p} у получателя ${o.recipient} пустая фамилия`);
      if (!EMAIL_RE.test(r.email)) errors.push(`${p} у получателя ${o.recipient} неверный email`);
      if (!PHONE_RE.test(r.phone)) errors.push(`${p} у получателя ${o.recipient} телефон должен быть 05XXXXXXXX`);
    }
    if (o.recipient && recUse.has(o.recipient)) errors.push(`${p} получатель ${o.recipient} уже в заказе ${recUse.get(o.recipient)} — у каждого заказа свой получатель`);
    if (o.recipient) recUse.set(o.recipient, o.id);
    if (o.payment === 'card') cardOrders++;
  }
  // карты
  const cardIds = new Set<string>();
  for (const c of sec.cards) {
    const p = `Карта ${c.id}:`;
    if (cardIds.has(c.id)) errors.push(`${p} id повторяется`);
    cardIds.add(c.id);
    if (!/^\d{13,19}$/.test(c.number)) errors.push(`${p} номер — 13–19 цифр`);
    else if (!luhn(c.number)) errors.push(`${p} номер не проходит проверку контрольной цифры (Луна) — опечатка?`);
    if (!/^(0[1-9]|1[0-2])\s?\/\s?(\d{2}|\d{4})$/.test(c.expiry)) errors.push(`${p} срок — MM/YY`);
    if (!/^\d{3,4}$/.test(c.cvv)) errors.push(`${p} CVV — 3–4 цифры`);
    const b = c.billing;
    if (!b.street || !b.area || !b.city) errors.push(`${p} billing-адрес не заполнен (street, area, city обязательны — без него Review не откроется)`);
    if (!(b.firstName || '') && !(c.name || '')) warnings.push(`${p} billing.firstName пуст — подставится имя получателя`);
  }
  const primaryCap = sec.cards.filter((c) => c.role === 'primary').reduce((a, c) => a + c.maxOrders, 0);
  if (cardOrders > primaryCap) errors.push(`заказов с оплатой картой ${cardOrders}, а основные (primary) карты покрывают ${primaryCap} с учётом maxOrders`);
  if (cardOrders && !sec.cards.some((c) => c.role === 'reserve')) warnings.push('нет запасных (reserve) карт — при отказе карты браузеры с ней сразу перейдут на Apple Pay');
  // браузеры и прокси
  if (cfg.fleet.browsers < cfg.orders.length) errors.push(`браузеров ${cfg.fleet.browsers} меньше, чем заказов ${cfg.orders.length}`);
  if (cfg.fleet.browsers > 20) warnings.push(`браузеров ${cfg.fleet.browsers} — около 0,5 ГБ памяти на браузер; проверь bot bench (T17)`);
  const needProxies = cfg.proxies.mode === 'off' ? 0 : cfg.proxies.mode === 'all' ? cfg.fleet.browsers : Math.max(0, cfg.fleet.browsers - cfg.proxies.directBrowsers);
  const haveSlots = sec.proxies.length * cfg.proxies.maxBrowsersPerProxy;
  if (needProxies > haveSlots) errors.push(`прокси не хватает: нужно мест ${needProxies} (browsers − directBrowsers), есть ${sec.proxies.length} × ${cfg.proxies.maxBrowsersPerProxy}`);
  for (const px of sec.proxies) {
    if (!/^(https?|socks5h?|socks):\/\//i.test(px.url)) errors.push(`Прокси ${px.id}: адрес должен быть http://user:pass@host:port или socks5://…`);
  }
  const pxIds = new Set<string>();
  for (const px of sec.proxies) { if (pxIds.has(px.id)) errors.push(`Прокси ${px.id}: id повторяется`); pxIds.add(px.id); }
  // уведомления
  if (cfg.notify.telegram.enabled && (!sec.telegram.botToken || !sec.telegram.chatId)) errors.push('Telegram включён, но в secrets нет botToken или chatId');
  if (cfg.notify.webhooks.enabled && !sec.webhooks.length) warnings.push('вебхуки включены, но в secrets.webhooks пусто');
  // время и сайт
  errors.push(...timingErrors(cfg.timing));
  const openAt = Date.parse(cfg.openAt);
  if (!Number.isFinite(openAt)) errors.push('openAt — не дата ISO');
  else if (openAt <= now) warnings.push('openAt в прошлом — старт сразу «после открытия» (нормально для тестов на живом товаре)');
  if (!/^https?:\/\//.test(cfg.baseUrl)) errors.push('baseUrl должен начинаться с http(s)://');
  const mock = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(cfg.baseUrl);
  if (mock && !opts.devBuild) errors.push(`baseUrl ${cfg.baseUrl} — мок работает только с dev-сборкой (fleet.extensionDir: "dist-dev")`);
  if (!mock && cfg.baseUrl !== 'https://www.apple.com') errors.push(`baseUrl ${cfg.baseUrl}: только https://www.apple.com или мок`);
  if (cfg.fleet.strategyMix.refresh < 0 || cfg.fleet.strategyMix.hold < 0 || cfg.fleet.strategyMix.refresh + cfg.fleet.strategyMix.hold <= 0) errors.push('fleet.strategyMix: доли ≥ 0, сумма > 0');
  if (cfg.payment.stopBeforePay) warnings.push('payment.stopBeforePay — пробный прогон: стоп на Review, ничего не оплачивается');
  if (!cfg.payment.stopBeforePay && cardOrders) warnings.push('оплата картой до конца: бот сам нажмёт Place Order (один раз); если банк не запросит подтверждение, заказ оформится без тебя');
  if (sec.cards.length) warnings.push('карты лежат в secrets.local.json открытым текстом — после дропа bot wipe');
  return { errors, warnings };
}

// ---------- перевод в конфиг расширения ----------
export function lobbyOf(cfg: BotConfig): { targets: string[]; stores: string[] } {
  const top = [...cfg.orders].sort((a, b) => a.priority - b.priority)[0];
  return { targets: top?.targets ?? [], stores: top?.stores ?? [] };
}

export function botRuntime(cfg: BotConfig, browserId: string, strategy: Strategy, openJitter: boolean): BotRuntime {
  return {
    ...defaultBotRuntime(browserId),
    machine: cfg.machine,
    strategy,
    holdMaxWaitSec: cfg.fleet.holdMaxWaitSec,
    openJitter,
    stopBeforePay: cfg.payment.stopBeforePay,
    applePay: { cdpClick: cfg.payment.applePay.cdpClick && cfg.fleet.cdp, osClick: cfg.payment.applePay.osClick, timeoutSec: cfg.payment.applePay.timeoutSec, reopenTries: cfg.payment.applePay.reopenTries, fullscreen: cfg.payment.applePay.fullscreen },
    threeDsTimeoutSec: cfg.payment.card.threeDsTimeoutSec,
    directAtb: cfg.fleet.directAtb,
    blockHeavy: cfg.fleet.blockHeavy,
    warmupSec: cfg.fleet.warmupSec,
    snapshots: cfg.fleet.snapshots,
    lobby: lobbyOf(cfg),
    privacy: { ...cfg.privacy },
  };
}

export function toExtConfig(cfg: BotConfig, browserId: string, hubUrl: string, rt: BotRuntime): Config {
  return {
    profileId: browserId, hubUrl, openAt: cfg.openAt, mode: 'auto', orders: [],
    timing: { ...cfg.timing }, retries: { checkout: 4, slotsPerStore: 4 }, limits: { maxTabsTotal: 1 }, baseUrl: cfg.baseUrl, bot: rt,
  };
}

/** Заказ бота → заказ расширения: card → manual, получатель и карта из секретов (§14.10). */
export function toExtOrder(cfg: BotConfig, o: BotOrder, rec: Recipient, card: CardDef | null, method: PayMethod, browserId: string): OrderCfg {
  return {
    id: o.id, priority: o.priority, profiles: [browserId], racersPerProfile: 1,
    targets: o.targets, stores: o.stores, city: o.city, slot: o.slot,
    payment: method === 'card' ? 'manual' : 'applepay',
    applePayFallback: 'manual',
    cardFallback: o.cardFallback,
    allowApplePayExpress: false,
    contact: { ...rec },
    card: card ? { number: card.number, expiry: card.expiry, cvv: card.cvv, name: card.name } : { number: '', expiry: '', cvv: '', name: '' },
    billing: card ? { ...card.billing } : { title: '', firstName: '', lastName: '', street: '', area: '', town: '', city: 'Dubai' },
    autoReview: true,
    autoPlaceOrder: !cfg.payment.stopBeforePay,
    deliveryFallback: o.deliveryFallback,
    address: { ...o.address },
    ...(card ? { cardId: card.id } : {}),
  };
}

export function last4(n: string): string {
  return n ? n.replace(/\D/g, '').slice(-4) : '';
}
