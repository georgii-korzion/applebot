// Типы сообщений SW ↔ content ↔ hub (§5.4).
import type { Config, OrderCfg } from './config';
import type { BotCommand, ClickTarget, HumanReason, PayWaitKind, StepPerf, Strategy } from './bot';

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
  /** Place Order нажат расширением (autoPlaceOrder) — повторно не нажимать, даже после перезагрузки страницы. */
  placeOrderTried?: boolean;
  placeOrderAt?: number;
  // ---------- режим бота ----------
  /** Когда вошли в текущее состояние (для пульса и сторожа). */
  stateSince?: number;
  /** Накопленное время шага: сеть / ожидание элемента / пауза (§20 bench). */
  perf?: { net: number; wait: number; pause: number };
  /** «Дальше я сам»: расширение только наблюдает и ловит номер заказа. */
  manual?: boolean;
  /** ADMITTED отправлен для текущего цикла «пул → заказ». */
  admitSent?: boolean;
  admittedAt?: number;
  warmedUp?: boolean;
  blockedInRow?: number;
  captchaSince?: number;
  /** Исход после Place Order (§9.1). */
  payOutcome?: 'WAIT_3DS' | 'CARD_DECLINED' | 'NEED_HUMAN' | 'ORDERED';
  threeDsSince?: number;
  /** Apple Pay: сколько раз открывали лист, когда показали QR. */
  applePayOpens?: number;
  qrShownAt?: number;
  /** Ждём возврата на Billing: смена карты / способа оплаты (§9.3). */
  swapPending?: 'card' | 'applepay';
  /** Попытка оплаты по заказу (1 — первая, 2 — Apple Pay после отказа карты). */
  payAttempt?: number;
  /** На какой попытке оплаты нажат Place Order (после SWITCH_PAY исход прошлой попытки уже не ждём). */
  placedAttempt?: number;
  /** Классы страниц, для которых уже снят снимок заглушки (§7). */
  snapClasses?: string[];
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
  // режим бота
  admittedAt?: number;
  spare?: boolean;
  placedAt?: number;
  payWait?: 'WAIT_3DS' | 'WAIT_APPLEPAY';
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
  | { t: 'STATE'; state: string; mode: Mode; detail?: string; outcome?: string; counters?: { reloads: number; atb404: number }; page?: string; step?: string; since?: number; perf?: StepPerf }
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
  | { t: 'PING' }
  // режим бота
  | { t: 'ADMITTED'; part?: string; at: number }
  | { t: 'PLACE_REQ' }
  | { t: 'PLACED'; at: number }
  | { t: 'PAY_WAIT'; kind: PayWaitKind; input?: boolean; detail?: string }
  | { t: 'CARD_DECLINED'; text: string }
  | { t: 'CARD_SWAP_ACK'; ok: boolean; detail?: string }
  | { t: 'CARD_REQ' }
  | { t: 'NEED_HUMAN'; reason: HumanReason; step: string; text: string }
  | { t: 'HUMAN_DONE' }
  | { t: 'HUMAN'; action: 'resume' | 'manual' | 'stop' }
  | { t: 'CLICK_REQ'; purpose: 'applepay'; how: 'cdp' | 'os'; target: ClickTarget }
  | { t: 'SNAPSHOT'; reason: string; cls: string; title: string; html: string; metaRefresh?: number; status: number }
  | { t: 'BLOCKED'; status: number; text: string }
  | { t: 'FULLSCREEN'; on: boolean };

// SW → content
export type S2C =
  | { t: 'WELCOME'; tabId: number; windowId: number; profileId: string; cfg: Config; order: OrderCfg | null; os: OrderState; ts: TabState; role: Role; hub: boolean; bot?: boolean }
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
  | { t: 'MODE'; mode: Mode; extra?: Partial<TabState>; reset?: boolean }
  // режим бота
  | { t: 'PLACE_TURN'; local?: boolean }
  | { t: 'CARD_SWAP'; card: OrderCfg['card']; cardId: string; billing: OrderCfg['billing'] }
  | { t: 'SWITCH_PAY'; method: 'applepay' }
  | { t: 'CMD'; cmd: BotCommand }
  | { t: 'CLICK_DONE'; ok: boolean; how: 'cdp' | 'os'; error?: string }
  | { t: 'SNAP_REQ'; reason: string }
  | { t: 'SPARE' };

// SW ↔ hub
export type Hub2S =
  | { t: 'WATCHER'; profile: string | null; targets?: string[]; profiles?: string[] }
  | { t: 'OPEN'; at: number; buyable: string[]; source: string }
  | { t: 'WIN'; orderId: string; profile: string; takeover?: boolean }
  | { t: 'LOSE'; orderId: string }
  | { t: 'CLEAN'; orderId: string }
  | { t: 'PAY_TURN'; orderId: string; profile: string }
  | { t: 'PONG' }
  // режим бота (§13)
  | { t: 'CONFIG'; cfg: Config }
  | { t: 'ASSIGN'; order: OrderCfg }
  | { t: 'SPARE' }
  | { t: 'UNASSIGN'; orderId: string; reason: string }
  | { t: 'SET_STRATEGY'; strategy: Strategy; reason?: string }
  | { t: 'PLACE_TURN'; orderId: string }
  | { t: 'CARD_SWAP'; orderId: string; cardId: string; card: OrderCfg['card']; billing: OrderCfg['billing'] }
  | { t: 'SWITCH_PAY'; orderId: string; method: 'applepay' }
  | { t: 'COMMAND'; cmd: BotCommand; arg?: string }
  | { t: 'CLICK_DONE'; ok: boolean; how: 'cdp' | 'os'; error?: string }
  | { t: 'REJECT'; reason: string };

export type S2Hub =
  | { t: 'REGISTER'; profile: string; orderId: string | null; priority: number; tabs: number; targets: string[]; bot?: BotRegister }
  | { t: 'OPEN'; profile: string; buyable: string[]; source: string }
  | { t: 'WIN_REQ'; orderId: string; profile: string }
  | { t: 'FAILED'; orderId: string; profile: string; reason: string }
  | { t: 'PAY_READY'; orderId: string; profile: string; priority: number; store: string; slotLabel: string; readyAt: number; record?: OrderRecord; method?: string }
  | { t: 'PAY_DONE'; orderId: string; profile: string; stage: string }
  | { t: 'NEXT' }
  | { t: 'ORDERED'; orderId: string; profile: string; orderNo: string; record?: OrderRecord }
  | { t: 'STATUS'; profile: string; orderId: string | null; stage?: string; tabs: TabRow[]; openedAt?: number }
  | { t: 'LOG'; line: string }
  | { t: 'PING' }
  // режим бота (§13)
  | { t: 'STATE'; profile: string; orderId: string | null; state: string; since: number; mode: Mode; detail?: string; page?: string; step?: string; path?: string; error?: string; reloads?: number; perf?: StepPerf; beat?: boolean; manual?: boolean }
  | { t: 'SNAPSHOT'; profile: string; reason: string; cls: string; url: string; title: string; html: string; status: number; metaRefresh?: number; headers?: Record<string, string> }
  | { t: 'ADMITTED'; profile: string; at: number; part?: string; reloads?: number }
  | { t: 'RELEASED'; profile: string; orderId: string; reason: string }
  | { t: 'PLACE_REQ'; profile: string; orderId: string }
  | { t: 'PLACED'; profile: string; orderId: string; at: number }
  | { t: 'PAY_WAIT'; profile: string; orderId: string; kind: PayWaitKind; input?: boolean; detail?: string }
  | { t: 'CARD_DECLINED'; profile: string; orderId: string; text: string }
  | { t: 'CARD_SWAP_ACK'; profile: string; orderId: string; cardId?: string; ok: boolean; detail?: string }
  | { t: 'CARD_REQ'; profile: string; orderId: string }
  | { t: 'NEED_HUMAN'; profile: string; orderId: string | null; reason: HumanReason; step: string; text: string }
  | { t: 'HUMAN_DONE'; profile: string }
  | { t: 'HUMAN'; profile: string; action: 'resume' | 'manual' | 'stop' }
  | { t: 'CLICK_REQ'; profile: string; purpose: 'applepay'; how: 'cdp' | 'os'; target: ClickTarget }
  | { t: 'BLOCKED'; profile: string; status: number; text: string }
  | { t: 'PREPARED'; profile: string; ok: boolean; detail: string }
  | { t: 'CLEANED'; profile: string; count: number };

/** Что браузер сообщает о себе при (пере)подключении — хаб восстанавливает картину после перезапуска (§3.6). */
export interface BotRegister {
  token: string;
  state: string;
  mode: Mode;
  inBag: boolean;
  leader: boolean;
  placed: boolean;
  payMethod?: string;
  orderNo?: string;
  openedAt?: number;
  ext: string;
}

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
  /** Режим бота: машина и последние 4 цифры карты. */
  machine?: string;
  cardLast4?: string;
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
