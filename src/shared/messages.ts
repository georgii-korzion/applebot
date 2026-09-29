// Типы сообщений SW ↔ content ↔ hub (§5.4).
import type { Config, OrderCfg } from './config';

export type Mode = 'idle' | 'race' | 'checkout' | 'standby' | 'prep' | 'clean';
export type Role = 'watcher' | 'racer' | 'standby' | 'idle';
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
  standbyUntil?: number;
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
  watchTargets?: string[];
  watcherTabId?: number;
  raceTabs: number[];
  lock?: { tabId: number; until: number };
  inBag?: boolean;
  inBagVerified?: boolean;
  inBagAt?: number;
  winnerTabId?: number;
  decision?: 'pending' | 'go' | 'standby';
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

// content → SW
export type C2S =
  | { t: 'HELLO'; url: string; kind: string; mode?: Mode; state?: string }
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
  | { t: 'STANDBY'; holdSec: number }
  | { t: 'CLEAN' }
  | { t: 'FOCUS_FOR_PAY'; label: string }
  | { t: 'CONFIG'; cfg: Config; order: OrderCfg | null }
  | { t: 'OS'; os: OrderState }
  | { t: 'DIAG'; net: { url: string; status: number; ago: number }[] }
  | { t: 'NET'; kind: 'updateSummary'; acpartNone: boolean; at: number }
  | { t: 'SW_WATCH'; at: number; ok: boolean }
  | { t: 'MODE'; mode: Mode; extra?: Partial<TabState> };

// SW ↔ hub
export type Hub2S =
  | { t: 'WATCHER'; profile: string | null; targets?: string[] }
  | { t: 'OPEN'; at: number; buyable: string[]; source: string }
  | { t: 'WIN'; orderId: string; profile: string; takeover?: boolean }
  | { t: 'LOSE'; orderId: string }
  | { t: 'CLEAN'; orderId: string }
  | { t: 'PAY_TURN'; orderId: string; profile: string }
  | { t: 'PONG' };

export type S2Hub =
  | { t: 'REGISTER'; profile: string; orderId: string | null; priority: number; tabs: number; targets: string[] }
  | { t: 'OPEN'; profile: string; buyable: string[]; source: string }
  | { t: 'WIN_REQ'; orderId: string; profile: string }
  | { t: 'FAILED'; orderId: string; profile: string; reason: string }
  | { t: 'PAY_READY'; orderId: string; profile: string; priority: number; store: string; slotLabel: string; readyAt: number; record?: OrderRecord }
  | { t: 'PAY_DONE'; orderId: string; profile: string; stage: string }
  | { t: 'NEXT' }
  | { t: 'ORDERED'; orderId: string; profile: string; orderNo: string; record?: OrderRecord }
  | { t: 'STATUS'; profile: string; orderId: string | null; stage?: string; tabs: TabRow[]; openedAt?: number }
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
  openedAt?: number;
  billingAt: number;
  orderedAt?: number;
  orderNo?: string;
  status: 'BILLING_READY' | 'ORDERED';
}

// popup/options → SW
export type Cmd =
  | { cmd: 'status' }
  | { cmd: 'start' }
  | { cmd: 'stop' }
  | { cmd: 'prepare' }
  | { cmd: 'cleanBag' }
  | { cmd: 'nextPay' }
  | { cmd: 'toggleAssist' }
  | { cmd: 'exportLog' }
  | { cmd: 'exportOrders' }
  | { cmd: 'clearLog' }
  | { cmd: 'focusTab'; tabId: number }
  | { cmd: 'reloadConfig' };
