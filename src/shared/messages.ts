// Типы сообщений SW ↔ content ↔ hub (§5.4; хаб v2 — FLEET-SPEC §9.3).
import type { Config, OrderCfg, Strategy } from './config';

export type Mode = 'idle' | 'race' | 'checkout' | 'prep' | 'clean';
export type Role = 'watcher' | 'racer' | 'idle';
export type AtbOutcome = 'OK' | 'ATB_404' | 'BUSY' | 'ATB_TIMEOUT' | 'ATB_RELOAD' | 'EMPTY_BAG';

/** Состояние вкладки (chrome.storage.session `tab:<id>`), владелец — content script. */
export interface TabState {
  mode: Mode;
  state: string;
  detail?: string;
  target?: string;
  reloads: number;
  lastReloadAt?: number;
  atb404InRow: number;
  atbPendingSince?: number;
  atbPart?: string;
  atbAssist?: boolean;
  sawAcpartNone?: boolean;
  countryInRow: number;
  busyInRow: number;
  /** hold: заглушка без meta refresh — ждём holdBusyWaitSec с этого момента, потом один рефреш. */
  busyHoldSince?: number;
  /** hold не дождался своего OPEN за holdFallbackSec — дальше как refresh (флаг переживает перезагрузку). */
  holdFallback?: boolean;
  fails: Record<string, number>;
  checkoutRetries: number;
  lastOutcome?: string;
  paused?: boolean;
  hidden?: boolean;
  store?: string;
  slot?: string;
  slotLabel?: string;
  slotAt?: number;
  billingAt?: number;
  payMethod?: string;
  payStartedAt?: number;
  prepPhase?: 'home' | 'bag' | 'check' | 'done';
  orderNo?: string;
  storeClosed?: boolean;
  lastTargetNavAt?: number;
  emptyBagInRow: number;
  queueSince?: number;
  applePayExpress?: boolean;
  countryTried?: boolean;
  price?: string;
  cardFilled?: boolean;
  payTurn?: boolean;
  applePayTried?: boolean;
  /** Попытки открыть лист Apple Pay (QR): программный клик → debugger-клик → человек; повтор до applePayRetries. */
  applePayTries?: number;
  applePayAt?: number;
  /** Place Order нажат расширением (autoPlaceOrder) — повторно не нажимать, даже после перезагрузки страницы. */
  placeOrderTried?: boolean;
  placeOrderAt?: number;
  updatedAt: number;
}

export function newTabState(mode: Mode = 'idle', extra: Partial<TabState> = {}): TabState {
  return {
    mode, state: mode === 'idle' ? 'IDLE' : 'INIT', reloads: 0, atb404InRow: 0, countryInRow: 0,
    busyInRow: 0, fails: {}, checkoutRetries: 0, emptyBagInRow: 0, updatedAt: Date.now(), ...extra,
  };
}

/** Состояние заказа профиля (chrome.storage.session `order`), владелец — SW. */
export interface OrderState {
  armed: boolean;
  startedAt?: number;
  openedAt?: number;
  openSource?: string;
  activeTarget?: string;
  watcherTabId?: number;
  raceTabs: number[];
  lock?: { tabId: number; until: number };
  inBag?: boolean;
  inBagVerified?: boolean;
  inBagAt?: number;
  winnerTabId?: number;
  /** Корзина подтверждена → сразу 'go' (решений хаба больше нет, FLEET-SPEC §3). */
  decision?: 'go';
  stage?: string;
  store?: string;
  slotLabel?: string;
  billingReadyAt?: number;
  orderNo?: string;
  storeClosedSince?: number;
  storeReopenedAt?: number;
  watch?: Record<string, { isBuyable: boolean; reason?: string; quote?: string; at: number }>;
  watchAt?: number;
  watchSource?: 'tab' | 'sw';
  /** Кого-то из флота уже пустили (OPEN_SEEN от хаба) — только для плашки, на поведение не влияет. */
  fleetOpen?: { profile: string; at: number; sinceOpenAt?: number };
  timestamps: Record<string, number>;
}

export function newOrderState(): OrderState {
  return { armed: false, raceTabs: [], timestamps: {} };
}

export interface AtbDiag {
  url: string;
  hasAcpartNone: boolean;
  hasAtbtoken: boolean;
  hasIgt: boolean;
  hasProduct: boolean;
  sawAcpartNone?: boolean;
  navStatus: number;
  net: { url: string; status: number; ago: number }[];
  cookies: { as_atb: boolean; geo: string | null };
  lang: string;
  tz: string;
  countryInUrl: boolean;
}

/** Выходной IP профиля (через прокси или напрямую), chrome.storage.local `egress`. */
export interface Egress { ip?: string; country?: string; at: number; error?: string }

// content → SW
export type C2S =
  | { t: 'HELLO'; url: string; kind: string; mode?: Mode; state?: string }
  | { t: 'IDENTITY'; profileId: string; hubUrl: string }
  | { t: 'STATE'; state: string; mode: Mode; detail?: string; outcome?: string; counters?: { reloads: number; atb404: number } }
  | { t: 'OPEN'; source: string; buyable: string[] }
  | { t: 'WATCH'; statuses: Record<string, { isBuyable: boolean; reason?: string; quote?: string }>; pickup?: string }
  | { t: 'WATCH_TICK'; ok: boolean }
  | { t: 'ATB_LOCK_REQ'; ttl: number }
  | { t: 'ATB_RESULT'; ok: boolean; outcome: AtbOutcome; diag?: AtbDiag }
  | { t: 'BAG'; ok: boolean; detail?: string }
  | { t: 'BILLING_READY'; store: string; slot: string; slotLabel: string; method: string; price?: string; cardFilled?: boolean }
  | { t: 'ORDERED'; orderNo: string }
  | { t: 'ASSIST'; step: string; msg: string }
  | { t: 'ALERT'; title: string; msg: string; sound?: SoundKind }
  | { t: 'DIAG_REQ' }
  | { t: 'PREPARED'; ok: boolean; detail: string }
  | { t: 'CLEANED'; count: number }
  | { t: 'STORE'; closed: boolean; reason: string }
  | { t: 'APPLEPAY_CLICK_REQ'; x: number; y: number }
  | { t: 'APPLEPAY_COORDS'; x: number; y: number }
  | { t: 'LOG'; level: 'info' | 'warn' | 'error'; msg: string; state?: string }
  | { t: 'PING' };

// SW → content
export type S2C =
  | { t: 'WELCOME'; tabId: number; windowId: number; profileId: string; cfg: Config; order: OrderCfg | null; os: OrderState; ts: TabState; role: Role; hub: boolean }
  | { t: 'ROLE'; role: Role }
  | { t: 'OPEN'; activeTarget?: string }
  | { t: 'ATB_LOCK'; granted: boolean; reason?: string }
  | { t: 'STOP'; reason: string }
  | { t: 'GO_BAG' }
  | { t: 'FOCUS_FOR_PAY'; label: string }
  | { t: 'CONFIG'; cfg: Config; order: OrderCfg | null }
  | { t: 'OS'; os: OrderState }
  | { t: 'DIAG'; net: { url: string; status: number; ago: number }[] }
  | { t: 'NET'; kind: 'updateSummary'; acpartNone: boolean; at: number }
  | { t: 'SW_WATCH'; at: number; ok: boolean }
  | { t: 'APPLEPAY_COORDS_REQ' }
  | { t: 'APPLEPAY_CLICK_DONE'; ok: boolean; error?: string }
  | { t: 'MODE'; mode: Mode; extra?: Partial<TabState> };

// ---------- хаб v2 (FLEET-SPEC §9.3): хаб только наблюдает, ни одно сообщение не блокирует покупку ----------
export type HubCmd = 'start' | 'stop' | 'prepare' | 'cleanBag' | 'reloadConfig' | 'setStrategy' | 'focus' | 'checkIp';

export type Hub2S =
  | { t: 'WELCOME'; serverTime: number; cfgVersion: number | null }
  | { t: 'OPEN_SEEN'; profile: string; at: number; sinceOpenAt?: number }
  | { t: 'CONFIG_AVAILABLE'; version: number }
  | { t: 'COMMAND'; cmd: HubCmd; args?: Record<string, unknown> }
  | { t: 'PONG' };

export type S2Hub =
  | { t: 'REGISTER'; profile: string; server: string; extVersion: string; cfgVersion: number; strategy: Strategy; targets: string[]; egress?: Egress }
  | { t: 'STATUS'; profile: string; stage?: string; tabs: TabRow[]; openedAt?: number; cfgVersion: number; cfgPending?: number; strategy: Strategy; egress?: Egress; armed: boolean }
  /** replay — повтор после переподключения: хаб мог пропустить событие, пока лежал (FLEET-SPEC §9.6). */
  | { t: 'OPEN'; profile: string; source: string; buyable: string[]; at: number; replay?: boolean }
  | { t: 'PAY_READY'; profile: string; store: string; slotLabel: string; method: string; readyAt: number; record?: OrderRecord; replay?: boolean }
  | { t: 'ORDERED'; profile: string; orderNo: string; record?: OrderRecord; replay?: boolean }
  | { t: 'LOG'; line: string }
  | { t: 'PING' };

export interface TabRow {
  tabId: number;
  role: Role;
  mode: Mode;
  state: string;
  detail?: string;
  outcome?: string;
  url?: string;
  reloads?: number;
  atb404?: number;
  updatedAt: number;
}

export type SoundKind = 'open' | 'pay' | 'assist' | 'alert' | 'done';

/** Запись о заказе (chrome.storage.local `orders`) — без масок: это данные владельца на его машине. */
export interface OrderRecord {
  key: string;
  profileId: string;
  orderId: string;
  part: string;
  partLabel: string;
  store: string;
  storeName: string;
  slotLabel: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  payment: string;
  price?: string;
  /** openAt конфига на момент записи — чтобы autoStart не начинал гонку заново после оформленного заказа. */
  openAt?: string;
  openedAt?: number;
  billingAt: number;
  orderedAt?: number;
  orderNo?: string;
  status: 'BILLING_READY' | 'ORDERED';
}

// popup/options/хаб → SW
export type Cmd =
  | { cmd: 'status' }
  | { cmd: 'start'; source?: string }
  | { cmd: 'stop' }
  | { cmd: 'prepare' }
  | { cmd: 'cleanBag' }
  | { cmd: 'toggleAssist' }
  | { cmd: 'setStrategy'; strategy: Strategy }
  | { cmd: 'checkIp' }
  | { cmd: 'fetchConfig' }
  | { cmd: 'focus' }
  | { cmd: 'exportLog' }
  | { cmd: 'exportOrders' }
  | { cmd: 'clearLog' }
  | { cmd: 'focusTab'; tabId: number }
  | { cmd: 'reloadConfig' };
