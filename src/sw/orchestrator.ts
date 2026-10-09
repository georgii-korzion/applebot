// Оркестратор профиля (§5.1, FLEET-SPEC §2): конфиг, состояние заказа, лок Add to Bag, победитель среди вкладок
// профиля, оплата, хаб. Профиль автономен: хаб только наблюдает, ни один шаг покупки его ответа не ждёт.
import {
  K, closedReloadMs, configUrlFromHub, isMockBase, loadConfig, normalizeConfig, orderFor, serverOf, validateConfig,
  type CfgMeta, type Config, type OrderCfg, type Strategy,
} from '../shared/config';
import { LogStore, fmtLine, maskUrl, registerSecret, scrub } from '../shared/log';
import {
  newOrderState, newTabState,
  type C2S, type Cmd, type Egress, type Hub2S, type HubCmd, type Mode, type OrderRecord, type OrderState, type Role, type S2C, type TabRow, type TabState,
} from '../shared/messages';
import { partLabel, partUrl, storeName } from '../shared/parts';
import { pollFm } from '../shared/watch';
import { HubClient } from './hubClient';
import { notify, playSound } from './notify';
import { focusTab } from './windows';
import { assignRoles, computeRoles } from './watcher';
import { forgetTab, recent } from './diag';
import { applyProxy, fetchEgress, proxyKey, proxyLabel } from './proxy';
import { debuggerClick, type Point } from './applePay';

export interface TabInfo {
  tabId: number;
  windowId: number;
  port: chrome.runtime.Port | null;
  url: string;
  mode: Mode;
  state: string;
  detail?: string;
  outcome?: string;
  role: Role;
  reloads: number;
  atb404: number;
  updatedAt: number;
}

interface PayItem { tabId: number; orderId: string; priority: number; readyAt: number; store: string; slotLabel: string }

const QUEUE_KEY = 'payQueue';
const CONFIG_FETCH_MS = 5000;

export class Orchestrator {
  cfg!: Config;
  order: OrderCfg | null = null;
  os: OrderState = newOrderState();
  tabs = new Map<number, TabInfo>();
  logs = new LogStore();
  hub: HubClient;
  /** Очередь оплаты внутри профиля (racersPerProfile > 1); при одной вкладке — сразу её ход. */
  payQueue: PayItem[] = [];
  payActive: number | null = null;
  cfgMeta: CfgMeta | null = null;
  /** Хаб сообщил о новой версии конфига, пока профиль в гонке — применится при следующем Start. */
  cfgPending?: number;
  egress: Egress | null = null;
  ready: Promise<void>;

  private pendingInit = new Map<number, TabState>();
  private pendingCmds = new Map<number, S2C[]>();
  private statusTimer: ReturnType<typeof setTimeout> | undefined;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private lastReloadAt = 0;
  private awayCount = new Map<number, number>();
  private awayTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private storeNotifiedAt = 0;
  private tabTickAt = 0;
  private swWatchTimer: ReturnType<typeof setTimeout> | undefined;
  private swWatchErrors = 0;
  private swWatchBusy = false;
  private proxyApplied: string | null = null;
  /** ipCheckUrl последней проверки — чтобы перепроверить выход, когда адрес сменился. */
  private ipCheckedUrl = '';
  private autoStarting = false;
  private fetching: Promise<{ ok: boolean; error?: string; version?: number }> | null = null;
  private coordsWaiters = new Map<number, (p: Point | null) => void>();

  constructor() {
    this.hub = new HubClient((m) => this.onHub(m), (c) => this.onHubState(c));
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    await this.logs.load();
    this.cfg = await loadConfig();
    this.order = orderFor(this.cfg) ?? null;
    const s = await chrome.storage.session.get([K.order, QUEUE_KEY]);
    this.os = { ...newOrderState(), ...(s[K.order] ?? {}) };
    const pq = (s[QUEUE_KEY] ?? {}) as { queue?: PayItem[]; active?: number | null };
    this.payQueue = pq.queue ?? [];
    this.payActive = pq.active ?? null;
    const l = await chrome.storage.local.get([K.cfgMeta, K.egress]);
    this.cfgMeta = (l[K.cfgMeta] as CfgMeta | undefined) ?? null;
    this.egress = (l[K.egress] as Egress | undefined) ?? null;
    if (this.cfg.proxy?.password) registerSecret(this.cfg.proxy.password);
    this.hub.setUrl(this.cfg.hubUrl);
    await this.syncProxy('старт SW');
    this.ensureSwWatch();
    // пульс STATUS раз в 10 с, пока SW жив (между событиями его может выгрузить — страхует alarm в index.ts)
    setInterval(() => this.hubStatusSoon(), 10_000);
    // автостарт после перезапуска Chrome: вкладкам нужно время подключиться, чтобы Start их переиспользовал
    setTimeout(() => { void this.maybeAutoStart('запуск'); }, 3000);
  }

  /** Вкладку гонки/чекаута Chrome не должен выгружать (Memory Saver): content script там — вся логика. */
  private keepTab(tabId: number): void {
    chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
  }

  // ---------- утилиты ----------
  log(tab: number | string, state: string, msg: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    const line = fmtLine({
      ts: Date.now(), openedAt: this.os.openedAt, openAt: Date.parse(this.cfg?.openAt ?? ''),
      profile: this.cfg?.profileId || '—', order: this.order?.id ?? '-', tab, state, msg: scrub(msg), level,
    });
    this.logs.push(line);
    this.hub.send({ t: 'LOG', line });
  }

  private async saveOs(push = false): Promise<void> {
    await chrome.storage.session.set({ [K.order]: this.os });
    if (push) for (const t of this.tabs.values()) this.sendTab(t.tabId, { t: 'OS', os: this.os }, false);
    this.hubStatusSoon();
  }

  private async savePay(): Promise<void> {
    await chrome.storage.session.set({ [QUEUE_KEY]: { queue: this.payQueue, active: this.payActive } });
  }

  /** Отправить вкладке; если порт закрыт (идёт навигация) и queue — доставить после WELCOME. */
  sendTab(tabId: number, m: S2C, queue = true): void {
    const t = this.tabs.get(tabId);
    if (t?.port) {
      try { t.port.postMessage(m); return; } catch { t.port = null; }
    }
    if (queue) this.pendingCmds.set(tabId, [...(this.pendingCmds.get(tabId) ?? []), m]);
  }

  private broadcast(m: S2C, filter: (t: TabInfo) => boolean = () => true): void {
    for (const t of this.tabs.values()) if (filter(t)) this.sendTab(t.tabId, m);
  }

  private async initTab(tabId: number, ts: TabState): Promise<void> {
    this.pendingInit.set(tabId, ts);
    await chrome.storage.session.set({ [K.tab(tabId)]: ts });
  }

  // ---------- вкладки ----------
  onConnect(port: chrome.runtime.Port): void {
    if (port.name !== 'tab') return;
    const tab = port.sender?.tab;
    if (!tab?.id) return;
    const tabId = tab.id;
    port.onMessage.addListener((m: C2S) => {
      this.onTabMsg(tabId, tab.windowId, port, m).catch((e) => this.log(tabId, 'SW', `ошибка: ${e}`, 'error'));
    });
    port.onDisconnect.addListener(() => {
      const t = this.tabs.get(tabId);
      if (t && t.port === port) t.port = null;
    });
  }

  private async onTabMsg(tabId: number, windowId: number, port: chrome.runtime.Port, m: C2S): Promise<void> {
    await this.ready;
    let t = this.tabs.get(tabId);
    if (m.t === 'HELLO') {
      const key = K.tab(tabId);
      const stored = (await chrome.storage.session.get(key))[key] as TabState | undefined;
      const ts = this.pendingInit.get(tabId) ?? stored ?? newTabState('idle');
      this.pendingInit.delete(tabId);
      if (!t) {
        t = { tabId, windowId, port, url: m.url, mode: ts.mode, state: ts.state, role: 'idle', reloads: ts.reloads, atb404: ts.atb404InRow, updatedAt: Date.now() };
        this.tabs.set(tabId, t);
      }
      Object.assign(t, { port, windowId, url: m.url, mode: ts.mode, state: ts.state });
      if (ts.mode !== 'idle') this.keepTab(tabId);
      const role = computeRoles(this).get(tabId) ?? 'idle';
      t.role = role;
      port.postMessage({
        t: 'WELCOME', tabId, windowId, profileId: this.cfg.profileId, cfg: this.cfg, order: this.order,
        os: this.os, ts, role, hub: this.hub.connected,
      } satisfies S2C);
      const queued = this.pendingCmds.get(tabId);
      if (queued) { this.pendingCmds.delete(tabId); for (const q of queued) port.postMessage(q); }
      assignRoles(this);
      return;
    }
    if (!t) return; // сообщение до HELLO — игнор
    t.updatedAt = Date.now();
    switch (m.t) {
      case 'IDENTITY':
        await this.onIdentity(tabId, m.profileId, m.hubUrl);
        break;
      case 'STATE': {
        const modeChanged = t.mode !== m.mode;
        Object.assign(t, { state: m.state, mode: m.mode, detail: m.detail, outcome: m.outcome });
        if (m.counters) { t.reloads = m.counters.reloads; t.atb404 = m.counters.atb404; }
        if (modeChanged || m.state === 'STUCK') assignRoles(this);
        if (tabId === this.os.winnerTabId && m.mode === 'checkout' && this.os.stage !== m.state) {
          this.os.stage = m.state;
          void this.saveOs();
        }
        if (m.state === 'STUCK' && tabId === this.os.winnerTabId && m.mode === 'checkout') this.onWinnerFailed(tabId, m.detail ?? 'STUCK');
        if (m.state === 'ORDERED' && tabId === this.payActive) void this.advancePay(m.state);
        this.hubStatusSoon();
        break;
      }
      case 'LOG':
        this.log(tabId, m.state ?? t.state, m.msg, m.level);
        break;
      case 'OPEN':
        await this.onOpen(m.source, m.buyable);
        break;
      case 'WATCH':
        this.recordWatch(tabId, m.statuses, m.pickup, 'tab');
        break;
      case 'WATCH_TICK':
        if (m.ok) this.tabTickAt = Date.now();
        break;
      case 'ATB_LOCK_REQ':
        this.sendTab(tabId, { t: 'ATB_LOCK', ...this.lockReq(tabId, m.ttl) }, false);
        break;
      case 'ATB_RESULT':
        if (m.ok) {
          this.os.inBag = true;
          this.os.lock = { tabId, until: Date.now() + 30_000 };
          this.os.timestamps.atbOk ??= Date.now();
          this.log(tabId, 'ATB_RESULT', 'OK — step=attach/корзина');
        } else {
          if (this.os.lock?.tabId === tabId) this.os.lock = undefined;
          const d = m.diag;
          this.log(tabId, 'ATB_RESULT', m.outcome + (d ? ` · url ${d.url} · acpart=none:${d.hasAcpartNone} atbtoken:${d.hasAtbtoken} igt:${d.hasIgt} product:${d.hasProduct}`
            + ` · updateSummary(acpart=none) до клика:${d.sawAcpartNone} · nav ${d.navStatus} · cookie as_atb:${d.cookies.as_atb} geo:${d.cookies.geo}`
            + ` · ${d.lang} ${d.tz} · /ae/:${d.countryInUrl} · net 10 с: ${d.net.map((n) => `${n.status} ${n.url.slice(0, 70)} (-${n.ago} мс)`).join(' | ') || '—'}` : ''), 'warn');
        }
        await this.saveOs();
        break;
      case 'BAG':
        if (m.ok) await this.onBagOk(tabId, m.detail ?? '');
        else if (this.os.winnerTabId === tabId || this.os.lock?.tabId === tabId) {
          const wasWinner = this.os.winnerTabId === tabId;
          this.log(tabId, 'BAG', `корзина не подтверждена: ${m.detail}`, 'warn');
          Object.assign(this.os, { inBag: false, inBagVerified: false, winnerTabId: undefined, decision: undefined, lock: undefined });
          await this.saveOs(true);
          if (wasWinner) this.rearmRace(tabId);
        }
        break;
      case 'BILLING_READY':
        await this.onBillingReady(tabId, m.store, m.slotLabel, m.method, m.price, m.cardFilled);
        break;
      case 'ORDERED': {
        this.os.orderNo = m.orderNo;
        this.os.stage = 'ORDERED';
        this.os.timestamps.ordered = Date.now();
        await this.saveOs();
        this.log(tabId, 'ORDERED', `номер заказа ${m.orderNo} — дальше ничего не делаем, вкладка и корзина остаются как есть`);
        void notify({ id: `ordered-${tabId}`, title: `${this.cfg.profileId}: заказ оформлен ✅`, message: m.orderNo, tabId, sound: 'done', sticky: true });
        const rec = await this.recordOrder({ orderNo: m.orderNo, orderedAt: Date.now(), status: 'ORDERED' });
        this.hub.send({ t: 'ORDERED', profile: this.cfg.profileId, orderNo: m.orderNo, record: rec });
        if (tabId === this.payActive) await this.advancePay('ORDERED');
        break;
      }
      case 'ASSIST':
        this.log(tabId, 'ASSIST', `${m.step}: ${m.msg}`, 'warn');
        await focusTab(tabId);
        void notify({ id: `assist-${tabId}`, title: `${this.cfg.profileId}: нужен клик`, message: m.msg, tabId, sound: 'assist', sticky: true });
        break;
      case 'ALERT':
        this.log(tabId, 'ALERT', `${m.title}: ${m.msg}`, 'warn');
        void notify({ title: m.title, message: m.msg, tabId, sound: m.sound });
        break;
      case 'DIAG_REQ':
        this.sendTab(tabId, { t: 'DIAG', net: recent(tabId) }, false);
        break;
      case 'PREPARED':
        await chrome.storage.local.set({ [K.prepared]: { ok: m.ok, detail: m.detail, at: Date.now() } });
        this.log(tabId, m.ok ? 'PREPARED' : 'PREP_FAILED', m.detail, m.ok ? 'info' : 'warn');
        void notify({ title: m.ok ? `Профиль ${this.cfg.profileId} готов ✓` : `Профиль ${this.cfg.profileId}: Prepare не прошёл`, message: m.detail, tabId, sound: m.ok ? undefined : 'alert' });
        break;
      case 'CLEANED':
        this.log(tabId, 'CLEANED', `корзина очищена, удалено ${m.count}`);
        break;
      case 'STORE':
        await this.onStore(tabId, m.closed, m.reason);
        break;
      case 'APPLEPAY_CLICK_REQ':
        await this.onApplePayClick(tabId, { x: m.x, y: m.y });
        break;
      case 'APPLEPAY_COORDS':
        this.coordsWaiters.get(tabId)?.({ x: m.x, y: m.y });
        break;
      case 'PING':
        break;
    }
  }

  onTabRemoved(tabId: number): void {
    const t = this.tabs.get(tabId);
    this.tabs.delete(tabId);
    this.pendingCmds.delete(tabId);
    forgetTab(tabId);
    this.clearAway(tabId);
    this.coordsWaiters.get(tabId)?.(null);
    void chrome.storage.session.remove(K.tab(tabId));
    if (!t) return;
    if (tabId === this.os.winnerTabId && t.mode === 'checkout' && this.os.stage !== 'ORDERED') this.onWinnerFailed(tabId, 'вкладка закрыта');
    if (tabId === this.payActive) void this.advancePay('closed');
    this.payQueue = this.payQueue.filter((p) => p.tabId !== tabId);
    assignRoles(this);
  }

  /**
   * Вкладка ушла с /ae/ — выбор страны увёл в другой регион (§7.5) или закрытый магазин
   * редиректит на заглушку вне /ae/, где content script не работает. Гонка: возвращаем на цель
   * по фазам (как рефреш закрытого магазина), пока задача взведена. Prepare: 3 попытки.
   */
  onTabUpdated(tabId: number, url: string | undefined, complete = true): void {
    if (!url) return;
    // вкладку, открытую Start, могло увести ещё до первого запуска content script
    const mode = this.tabs.get(tabId)?.mode ?? (this.os.raceTabs.includes(tabId) ? 'race' : undefined);
    // только гонка и прогрев: в чекауте возможны 3-D Secure и действия человека — не вмешиваемся
    if (!mode || !['race', 'prep'].includes(mode)) return;
    let u: URL;
    try { u = new URL(url); } catch { return; }
    const ours = u.hostname.endsWith('apple.com') || url.startsWith(this.cfg.baseUrl);
    if (!ours || u.pathname.toLowerCase().startsWith('/ae')) { this.clearAway(tabId); return; }
    if (!complete) return; // решаем по окончании загрузки: одна загрузка = одно событие
    const n = (this.awayCount.get(tabId) ?? 0) + 1;
    this.awayCount.set(tabId, n);
    if (n <= 3 || n % 20 === 0) this.log(tabId, 'AWAY', `вкладка ушла с /ae/: ${u.pathname} (${n})`, 'warn');
    if (mode === 'prep') {
      if (n > 3) void notify({ title: `Профиль ${this.cfg.profileId}: регион`, message: 'Вкладку уводит с /ae/ — проверь прокси и гео профиля', tabId, sound: 'alert' });
      else void chrome.tabs.update(tabId, { url: `${this.cfg.baseUrl}/ae/` });
      return;
    }
    if (!this.os.armed || !this.order) return;
    if (n === 2) void this.onStore(tabId, true, `редирект вне /ae/: ${u.pathname}`);
    if (n === 3) void notify({ id: `away-${tabId}`, title: `${this.cfg.profileId}: вкладку уводит с /ae/`, message: 'Возвращаю на страницу товара по расписанию. Если это не закрытие магазина — проверь прокси/гео.', tabId });
    // hold до своего OPEN: не чаще closedReloadMs, фаза не важна (FLEET-SPEC §4.2)
    const ms = this.cfg.strategy === 'hold' && !this.os.openedAt ? this.cfg.timing.closedReloadMs : closedReloadMs(this.cfg, this.os.openedAt);
    this.scheduleBack(tabId, n === 1 ? 0 : ms);
  }

  private scheduleBack(tabId: number, ms: number): void {
    clearTimeout(this.awayTimers.get(tabId));
    this.awayTimers.set(tabId, setTimeout(() => {
      this.awayTimers.delete(tabId);
      if (!this.order || !this.os.armed) return;
      const url = partUrl(this.cfg.baseUrl, this.os.activeTarget ?? this.order.targets[0]);
      void chrome.tabs.update(tabId, { url }).catch(() => {});
    }, ms));
  }

  private clearAway(tabId: number): void {
    this.awayCount.delete(tabId);
    clearTimeout(this.awayTimers.get(tabId));
    this.awayTimers.delete(tabId);
  }

  /** Страховка на случай выгрузки SW: вкладки, оставшиеся вне /ae/ без таймера, вернуть. */
  async checkAway(): Promise<void> {
    for (const tabId of this.awayCount.keys()) {
      if (this.awayTimers.has(tabId)) continue;
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab?.url) { this.clearAway(tabId); continue; }
      this.onTabUpdated(tabId, tab.url, tab.status === 'complete');
    }
  }

  /** Магазин закрыт / открылся — по отчётам вкладок. */
  private async onStore(tabId: number, closed: boolean, reason: string): Promise<void> {
    const now = Date.now();
    if (closed && !this.os.storeClosedSince) {
      this.os.storeClosedSince = now;
      this.log(tabId, 'CLOSED', `Apple Store закрыт (${reason}) — вкладки обновляются по стратегии ${this.cfg.strategy}, пока не пустит`, 'warn');
      if (now - this.storeNotifiedAt > 120_000) {
        this.storeNotifiedAt = now;
        void notify({ id: 'store', title: 'Apple Store закрыт', message: 'Расширение само обновляет страницы, пока магазин не откроется. Ничего делать не нужно.' });
      }
      await this.saveOs();
    } else if (!closed && this.os.storeClosedSince) {
      const mins = ((now - this.os.storeClosedSince) / 60000).toFixed(1);
      this.os.storeClosedSince = undefined;
      this.os.storeReopenedAt = now;
      this.log(tabId, 'REOPEN', `Apple Store открылся (${reason}), был закрыт ${mins} мин`);
      void notify({ id: 'store', title: 'Apple Store открылся', message: `Вкладки продолжают сами (${reason})`, sound: this.os.openedAt ? undefined : 'open' });
      await this.saveOs();
    }
  }

  /** Победитель потерял корзину — вернуть остановленные вкладки профиля в гонку. */
  private rearmRace(except: number): void {
    if (!this.os.armed) return;
    let n = 0;
    for (const id of this.os.raceTabs) {
      const t = this.tabs.get(id);
      if (!t || id === except || t.mode !== 'idle') continue;
      this.sendTab(id, { t: 'MODE', mode: 'race', extra: { ...newTabState('race'), target: this.os.activeTarget } });
      n++;
    }
    if (n) this.log('sw', 'REARM', `корзина потеряна — ${n} остановленных вкладок снова в гонке`);
  }

  private recordWatch(from: number | string, statuses: Record<string, { isBuyable: boolean; reason?: string; quote?: string }>, pickup: string | undefined, source: 'tab' | 'sw'): void {
    const at = Date.now();
    const txt = Object.entries(statuses).map(([p, s]) => `${p} ${s.isBuyable ? 'BUYABLE' : s.reason ?? '?'}${s.quote ? ` «${s.quote}»` : ''}`).join('; ');
    const prev = JSON.stringify(Object.fromEntries(Object.entries(this.os.watch ?? {}).map(([p, s]) => [p, [s.isBuyable, s.reason, s.quote]])));
    const next = JSON.stringify(Object.fromEntries(Object.entries(statuses).map(([p, s]) => [p, [s.isBuyable, s.reason, s.quote]])));
    this.os.watch = Object.fromEntries(Object.entries(statuses).map(([p, s]) => [p, { ...s, at }]));
    this.os.watchAt = at;
    this.os.watchSource = source;
    if (prev !== next || source === 'tab') this.log(from, 'WATCH', `${source === 'sw' ? '[sw] ' : ''}${txt}${pickup ? ` | pickup ${pickup}` : ''}`);
    void this.saveOs();
  }

  // ---------- страховочный поллер OPEN в SW ----------
  // Основной наблюдатель живёт во вкладке (§7.3, запросы same-origin из своей сессии). Скрытую вкладку Chrome
  // тормозит (таймеры, Memory Saver, окно за RDP), поэтому SW опрашивает сам, пока вкладка не подтверждает тиками, что жива.
  ensureSwWatch(): void {
    const should = this.os.armed && !this.os.openedAt && !!this.order;
    if (!should) { clearTimeout(this.swWatchTimer); this.swWatchTimer = undefined; return; }
    if (this.swWatchTimer) return;
    this.swWatchTimer = setTimeout(() => { this.swWatchTimer = undefined; void this.swWatchTick(); }, 1500);
  }

  private async swWatchTick(): Promise<void> {
    if (this.swWatchBusy) return;
    this.swWatchBusy = true;
    let delay = this.cfg.timing.pollMs;
    try {
      const tabFresh = Date.now() - this.tabTickAt < 3500;
      if (!tabFresh && this.order) {
        try {
          const r = await pollFm(this.cfg.baseUrl, this.order.targets, this.order.stores);
          this.swWatchErrors = 0;
          this.recordWatch('sw', r.statuses, r.pickup, 'sw');
          if (this.os.watcherTabId !== undefined) this.sendTab(this.os.watcherTabId, { t: 'SW_WATCH', at: Date.now(), ok: true }, false);
          if (r.buyable.length) await this.onOpen('sw-json', r.buyable);
        } catch (e) {
          this.swWatchErrors++;
          if (this.swWatchErrors === 1 || this.swWatchErrors % 20 === 0) this.log('sw', 'WATCH', `[sw] ошибка опроса (${this.swWatchErrors}): ${e}`, 'warn');
          if (this.swWatchErrors >= 3) delay = Math.min(10_000, this.cfg.timing.pollMs * 4);
        }
      }
    } finally {
      this.swWatchBusy = false;
      if (this.os.armed && !this.os.openedAt) this.swWatchTimer = setTimeout(() => { this.swWatchTimer = undefined; void this.swWatchTick(); }, delay);
    }
  }

  // ---------- OPEN (свой: JSON этой сессии сказал buyable) ----------
  async onOpen(source: string, buyable: string[]): Promise<void> {
    if (this.os.openedAt) return;
    this.os.openedAt = Date.now();
    this.os.openSource = source;
    this.os.timestamps.open = this.os.openedAt;
    const targets = this.order?.targets ?? [];
    const first = targets.find((p) => buyable.includes(p)) ?? this.os.activeTarget ?? targets[0];
    this.os.activeTarget = first;
    const openAt = Date.parse(this.cfg.openAt);
    const since = Number.isFinite(openAt) ? ` (${((this.os.openedAt - openAt) / 1000).toFixed(1)} с от openAt)` : '';
    this.log('sw', 'OPEN', `продажи открыты для этого профиля (${source})${since}, buyable: ${buyable.join(',') || '—'} → цель ${first ? partLabel(first) : '—'}`);
    await this.saveOs();
    this.broadcast({ t: 'OPEN', activeTarget: first });
    this.hub.send({ t: 'OPEN', profile: this.cfg.profileId, buyable, source, at: this.os.openedAt });
    assignRoles(this);
    this.ensureSwWatch();
    if (this.os.armed) void playSound('open');
  }

  // ---------- лок Add to Bag (§7.1) ----------
  private lockReq(tabId: number, ttl: number): { granted: boolean; reason?: string } {
    const now = Date.now();
    const os = this.os;
    if (os.inBagVerified && os.winnerTabId !== undefined && os.winnerTabId !== tabId) return { granted: false, reason: 'inBag' };
    if (os.lock && os.lock.tabId !== tabId && os.lock.until > now) {
      return { granted: false, reason: os.inBag ? 'inBag-pending' : `busy:${os.lock.tabId}` };
    }
    os.lock = { tabId, until: now + Math.min(Math.max(ttl, 1000), 180_000) };
    void this.saveOs();
    this.log(tabId, 'ATB_LOCK', `лок выдан на ${Math.round(ttl / 1000)} с`);
    return { granted: true };
  }

  // ---------- победитель среди вкладок профиля (§7.1) ----------
  private async onBagOk(tabId: number, detail: string): Promise<void> {
    const os = this.os;
    if (os.inBagVerified && os.winnerTabId !== undefined && os.winnerTabId !== tabId && this.tabs.has(os.winnerTabId)) {
      this.sendTab(tabId, { t: 'STOP', reason: `победитель уже есть (вкладка ${os.winnerTabId})` });
      return;
    }
    const first = os.winnerTabId !== tabId || !os.inBagVerified;
    // корзина подтверждена → сразу в чекаут: решений хаба нет (FLEET-SPEC §3)
    Object.assign(os, { winnerTabId: tabId, inBag: true, inBagVerified: true, lock: undefined, decision: 'go' });
    os.inBagAt ??= Date.now();
    if (first) {
      this.log(tabId, 'IN_BAG', `товар в корзине профиля: ${detail} → чекаут`);
      for (const t of this.tabs.values()) {
        if (t.tabId !== tabId && t.mode === 'race') this.sendTab(t.tabId, { t: 'STOP', reason: `товар в корзине (вкладка ${tabId})` });
      }
    }
    await this.saveOs(true);
    this.sendTab(tabId, { t: 'GO_BAG' });
    // видимая вкладка не тормозится браузером — чекаут идёт быстрее (окно не перехватываем, только вкладка)
    chrome.tabs.update(tabId, { active: true }).catch(() => {});
  }

  private onWinnerFailed(tabId: number, reason: string): void {
    this.log(tabId, 'FAILED', `чекаут остановился: ${reason}`, 'warn');
    void notify({ title: `${this.cfg.profileId}: чекаут остановился`, message: reason, tabId, sound: 'alert' });
  }

  // ---------- записи о заказах (chrome.storage.local `orders`) ----------
  private recordKey(): string {
    return `${this.cfg.profileId}:${this.order?.id ?? '?'}:${this.os.startedAt ?? 0}`;
  }

  async recordOrder(patch: Partial<OrderRecord>): Promise<OrderRecord | undefined> {
    const o = this.order;
    if (!o) return undefined;
    const s = await chrome.storage.local.get('orders');
    const list: OrderRecord[] = Array.isArray(s.orders) ? s.orders : [];
    const key = this.recordKey();
    const part = this.os.activeTarget ?? o.targets[0];
    const base: OrderRecord = list.find((r) => r.key === key) ?? {
      key, profileId: this.cfg.profileId, orderId: o.id, part, partLabel: partLabel(part),
      store: this.os.store ?? '', storeName: storeName(this.os.store), slotLabel: this.os.slotLabel ?? '',
      firstName: o.contact.firstName, lastName: o.contact.lastName, email: o.contact.email, phone: o.contact.phone,
      payment: o.payment, openAt: this.cfg.openAt, openedAt: this.os.openedAt, billingAt: this.os.billingReadyAt ?? Date.now(), status: 'BILLING_READY',
    };
    const rec: OrderRecord = { ...base, ...patch, store: this.os.store ?? base.store, storeName: storeName(this.os.store ?? base.store), slotLabel: this.os.slotLabel ?? base.slotLabel };
    const next = [...list.filter((r) => r.key !== key), rec].slice(-200);
    await chrome.storage.local.set({ orders: next });
    return rec;
  }

  async ordersCsv(): Promise<string> {
    const s = await chrome.storage.local.get('orders');
    const list: OrderRecord[] = Array.isArray(s.orders) ? s.orders : [];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const fmt = (t?: number) => (t ? new Date(t).toLocaleString('ru-RU') : '');
    const head = ['профиль', 'заказ', 'статус', 'номер заказа', 'товар', 'парт', 'магазин', 'окно самовывоза', 'имя', 'фамилия', 'email', 'телефон', 'оплата', 'сумма', 'OPEN', 'на оплате с', 'оформлен'];
    const rows = list.map((r) => [r.profileId, r.orderId, r.status, r.orderNo, r.partLabel, r.part, r.storeName, r.slotLabel, r.firstName, r.lastName, r.email, r.phone, r.payment, r.price, fmt(r.openedAt), fmt(r.billingAt), fmt(r.orderedAt)].map(esc).join(';'));
    return '﻿' + [head.map(esc).join(';'), ...rows].join('\n');
  }

  // ---------- оплата (§7.7, FLEET-SPEC §11): окно профиля сразу выходит вперёд, очередь только внутри профиля ----------
  private async onBillingReady(tabId: number, store: string, slotLabel: string, method: string, price?: string, cardFilled?: boolean): Promise<void> {
    Object.assign(this.os, { stage: 'BILLING_READY', store, slotLabel, billingReadyAt: Date.now() });
    this.os.timestamps.billing = Date.now();
    await this.saveOs();
    const took = this.os.openedAt ? ` (${((Date.now() - this.os.openedAt) / 1000).toFixed(1)} с от OPEN)` : '';
    this.log(tabId, 'BILLING_READY', `${storeName(store)} · ${slotLabel} · ${method}${price ? ` · ${price}` : ''}${cardFilled ? ' · карта заполнена' : ''}${took}`);
    const rec = await this.recordOrder({ price, billingAt: Date.now(), status: 'BILLING_READY' });
    // хабу — только информационно, ответа не ждём
    this.hub.send({ t: 'PAY_READY', profile: this.cfg.profileId, store, slotLabel, method, readyAt: Date.now(), record: rec });
    const item: PayItem = { tabId, orderId: this.order?.id ?? '?', priority: this.order?.priority ?? 99, readyAt: Date.now(), store, slotLabel };
    this.payQueue = [...this.payQueue.filter((p) => p.tabId !== tabId), item].sort((a, b) => a.priority - b.priority || a.readyAt - b.readyAt);
    await this.savePay();
    await this.activatePay();
  }

  private async activatePay(): Promise<void> {
    if (this.payActive !== null && this.tabs.has(this.payActive)) return;
    const next = this.payQueue.shift();
    this.payActive = next?.tabId ?? null;
    await this.savePay();
    if (next) await this.focusForPay(next.tabId);
  }

  private async focusForPay(tabId: number): Promise<void> {
    const o = this.order;
    const what = o?.payment === 'manual' ? 'введи карту' : 'подтверди Apple Pay';
    const label = `${this.cfg.profileId}: ${what}`;
    this.log(tabId, 'PAYING', `на оплату: ${storeName(this.os.store)} · ${this.os.slotLabel ?? ''}`);
    this.sendTab(tabId, { t: 'FOCUS_FOR_PAY', label });
    await focusTab(tabId);
    void notify({ id: `pay-${tabId}`, title: label, message: `${storeName(this.os.store)} · ${this.os.slotLabel ?? ''}`, tabId, sound: 'pay', sticky: true });
  }

  async advancePay(_reason: string): Promise<void> {
    this.payActive = null;
    await this.activatePay();
  }

  // ---------- Apple Pay: настоящий клик через debugger (FLEET-SPEC §8) ----------
  private async onApplePayClick(tabId: number, p: Point): Promise<void> {
    if (this.order?.applePayClick !== 'debugger') {
      this.sendTab(tabId, { t: 'APPLEPAY_CLICK_DONE', ok: false, error: 'applePayClick=dom' }, false);
      return;
    }
    this.log(tabId, 'APPLEPAY', `debugger-клик по кнопке Apple Pay (${Math.round(p.x)}, ${Math.round(p.y)})`);
    const r = await debuggerClick(tabId, p, () => this.requestCoords(tabId));
    this.log(tabId, 'APPLEPAY', r.ok ? 'debugger-клик отправлен, debugger отключится через 1,5 с' : `debugger-клик не удался: ${r.error}`, r.ok ? 'info' : 'warn');
    this.sendTab(tabId, { t: 'APPLEPAY_CLICK_DONE', ok: r.ok, error: r.error }, false);
  }

  private requestCoords(tabId: number): Promise<Point | null> {
    return new Promise((resolve) => {
      const to = setTimeout(() => { this.coordsWaiters.delete(tabId); resolve(null); }, 1000);
      this.coordsWaiters.set(tabId, (p) => { clearTimeout(to); this.coordsWaiters.delete(tabId); resolve(p); });
      this.sendTab(tabId, { t: 'APPLEPAY_COORDS_REQ' }, false);
    });
  }

  // ---------- хаб (только наблюдение) ----------
  private onHubState(connected: boolean): void {
    this.log('sw', 'HUB', connected ? `подключён ${maskUrl(this.hub.address)}` : 'отключён — работаю автономно, переподключаюсь', connected ? 'info' : 'warn');
    if (connected) this.register();
    this.broadcast({ t: 'OS', os: this.os }, (t) => !!t.port);
  }

  private register(): void {
    this.hub.send({
      t: 'REGISTER', profile: this.cfg.profileId, server: serverOf(this.cfg.profileId), extVersion: chrome.runtime.getManifest().version,
      cfgVersion: this.cfg.version, strategy: this.cfg.strategy, targets: this.order?.targets ?? [], egress: this.egress ?? undefined,
    });
    this.hubStatusSoon();
    void this.replayToHub();
  }

  /** После (пере)подключения повторить хабу то, что он мог пропустить за эту гонку: OPEN, PAY_READY, ORDERED. На хабе всё идемпотентно. */
  private async replayToHub(): Promise<void> {
    if (!this.os.openedAt) return;
    const profile = this.cfg.profileId;
    this.hub.send({ t: 'OPEN', profile, buyable: this.os.activeTarget ? [this.os.activeTarget] : [], source: this.os.openSource ?? '?', at: this.os.openedAt, replay: true });
    const s = await chrome.storage.local.get('orders');
    const list: OrderRecord[] = Array.isArray(s.orders) ? s.orders : [];
    const rec = list.find((r) => r.key === this.recordKey());
    if (!rec) return;
    this.hub.send({ t: 'PAY_READY', profile, store: rec.store, slotLabel: rec.slotLabel, method: rec.payment, readyAt: rec.billingAt, record: rec, replay: true });
    if (rec.status === 'ORDERED' && rec.orderNo) this.hub.send({ t: 'ORDERED', profile, orderNo: rec.orderNo, record: rec, replay: true });
  }

  private onHub(m: Hub2S): void {
    switch (m.t) {
      case 'WELCOME': {
        const newer = m.cfgVersion !== null && m.cfgVersion > this.cfg.version;
        this.log('sw', 'HUB', `хаб: конфиг v${m.cfgVersion ?? '—'}${newer ? ` (новее локального v${this.cfg.version})` : ''}`);
        if (newer) {
          if (this.os.armed) { this.cfgPending = m.cfgVersion!; this.hubStatusSoon(); }
          else void this.fetchConfigFromHub('welcome');
        }
        break;
      }
      case 'OPEN_SEEN':
        if (m.profile === this.cfg.profileId) break;
        this.os.fleetOpen = { profile: m.profile, at: m.at, sinceOpenAt: m.sinceOpenAt };
        this.log('sw', 'HUB', `кого-то уже пустили: ${m.profile}${m.sinceOpenAt !== undefined ? ` +${(m.sinceOpenAt / 1000).toFixed(1)} с` : ''} — у нас без изменений, ждём свой OPEN`);
        void this.saveOs(true);
        break;
      case 'CONFIG_AVAILABLE':
        if (this.os.armed) {
          this.cfgPending = m.version;
          this.log('sw', 'HUB', `конфиг v${m.version} есть на хабе — применю при следующем Start (профиль в гонке)`);
          this.hubStatusSoon();
        } else void this.fetchConfigFromHub('hub');
        break;
      case 'COMMAND':
        void this.onHubCommand(m.cmd, m.args ?? {});
        break;
      case 'PONG':
        break;
    }
  }

  private async onHubCommand(cmd: HubCmd, args: Record<string, unknown>): Promise<void> {
    const map: Record<HubCmd, Cmd> = {
      start: { cmd: 'start', source: 'hub' },
      stop: { cmd: 'stop' },
      prepare: { cmd: 'prepare' },
      cleanBag: { cmd: 'cleanBag' },
      reloadConfig: { cmd: 'fetchConfig' },
      setStrategy: { cmd: 'setStrategy', strategy: args.strategy === 'hold' ? 'hold' : 'refresh' },
      focus: { cmd: 'focus' },
      checkIp: { cmd: 'checkIp' },
    };
    const c = map[cmd];
    if (!c) { this.log('sw', 'HUB', `неизвестная команда хаба: ${String(cmd)}`, 'warn'); return; }
    this.log('sw', 'HUB', `команда хаба: ${cmd}${cmd === 'setStrategy' ? ` ${String(args.strategy)}` : ''}`);
    const r = (await this.onCommand(c)) as { ok?: boolean; error?: string } | undefined;
    if (r && r.ok === false) this.log('sw', 'HUB', `команда ${cmd} не выполнена: ${r.error ?? ''}`, 'warn');
    this.hubStatusSoon();
  }

  /** Пульс из alarm (index.ts): STATUS хабу, даже если SW недавно просыпался. */
  pulse(): void {
    this.hubStatusSoon();
  }

  private hubStatusSoon(): void {
    if (!this.hub.connected || this.statusTimer) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = undefined;
      this.hub.send({
        t: 'STATUS', profile: this.cfg.profileId, stage: this.os.stage, tabs: this.rows(), openedAt: this.os.openedAt,
        cfgVersion: this.cfg.version, cfgPending: this.cfgPending, strategy: this.cfg.strategy, egress: this.egress ?? undefined, armed: this.os.armed,
      });
    }, 400);
  }

  rows(): TabRow[] {
    return [...this.tabs.values()].sort((a, b) => a.tabId - b.tabId).map((t) => ({
      tabId: t.tabId, role: t.role, mode: t.mode, state: t.state, detail: t.detail, outcome: t.outcome,
      url: t.url ? new URL(t.url).pathname : '', reloads: t.reloads, atb404: t.atb404, updatedAt: t.updatedAt,
    }));
  }

  // ---------- конфиг ----------
  /** storage.onChanged после наших же записей — перечитать один раз, не дублируя прямой reloadConfig(). */
  reloadSoon(): void {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      if (Date.now() - this.lastReloadAt < 300) return;
      void this.reloadConfig();
    }, 200);
  }

  async reloadConfig(): Promise<void> {
    this.lastReloadAt = Date.now();
    const prevProxy = proxyKey(this.cfg.proxy, this.cfg.hubUrl);
    this.cfg = await loadConfig();
    this.order = orderFor(this.cfg) ?? null;
    if (this.cfg.proxy?.password) registerSecret(this.cfg.proxy.password);
    this.hub.setUrl(this.cfg.hubUrl);
    if (this.hub.connected) this.register();
    this.broadcast({ t: 'CONFIG', cfg: this.cfg, order: this.order }, (t) => !!t.port);
    this.ensureSwWatch();
    this.log('sw', 'CONFIG', `конфиг обновлён: профиль ${this.cfg.profileId || '— (не назначен)'}, v${this.cfg.version}, стратегия ${this.cfg.strategy}, прокси ${proxyLabel(this.cfg.proxy)}, режим ${this.cfg.mode}`);
    if (proxyKey(this.cfg.proxy, this.cfg.hubUrl) !== prevProxy || this.proxyApplied === null) await this.syncProxy('конфиг');
    // адрес проверки IP сменился (например, пришёл конфиг с хаба) — перепроверить выход, прокси при этом не трогаем
    else if (this.cfg.ipCheckUrl !== this.ipCheckedUrl) void this.checkIp();
  }

  /** Применить прокси из конфига; во время гонки IP не меняем (FLEET-SPEC §7). */
  private async syncProxy(reason: string): Promise<void> {
    const key = proxyKey(this.cfg.proxy, this.cfg.hubUrl);
    if (key === this.proxyApplied) return;
    if (this.os.armed && this.proxyApplied !== null) {
      this.log('sw', 'PROXY', `прокси в конфиге изменился (${proxyLabel(this.cfg.proxy)}), но профиль в гонке — применю при следующем Start`, 'warn');
      return;
    }
    const ok = await applyProxy(this.cfg.proxy, this.cfg.hubUrl, (m, l) => this.log('sw', 'PROXY', m, l));
    if (!ok && this.cfg.proxy) void notify({ id: 'proxy', title: `${this.cfg.profileId}: прокси не применён`, message: proxyLabel(this.cfg.proxy), sound: 'alert' });
    this.proxyApplied = key;
    this.log('sw', 'PROXY', `${this.cfg.proxy ? `прокси ${proxyLabel(this.cfg.proxy)} применён` : 'прокси снят, трафик напрямую'} (${reason})`);
    void this.checkIp();
  }

  proxyCreds(): { username: string; password: string } | null {
    const p = this.cfg?.proxy;
    return p?.username ? { username: p.username, password: p.password ?? '' } : null;
  }

  async checkIp(): Promise<Egress> {
    let e: Egress;
    this.ipCheckedUrl = this.cfg.ipCheckUrl;
    try {
      const r = await fetchEgress(this.cfg.ipCheckUrl);
      e = { ...r, at: Date.now() };
      const warn = e.country && e.country !== 'AE';
      this.log('sw', 'IP', `выход: ${e.ip ?? '?'} · ${e.country ?? '?'}${warn ? ' — не ОАЭ (ок, если так задумано)' : ''}${this.cfg.proxy ? ` через ${proxyLabel(this.cfg.proxy)}` : ''}`, warn ? 'warn' : 'info');
    } catch (err) {
      e = { at: Date.now(), error: String(err instanceof Error ? err.message : err) };
      this.log('sw', 'IP', `проверка IP не удалась: ${e.error}${this.cfg.proxy ? ` — прокси ${proxyLabel(this.cfg.proxy)} не отвечает?` : ''}`, 'warn');
      if (this.cfg.proxy) void notify({ id: 'proxy', title: `${this.cfg.profileId}: прокси не отвечает`, message: `${proxyLabel(this.cfg.proxy)} · ${e.error}`, sound: 'alert' });
    }
    this.egress = e;
    await chrome.storage.local.set({ [K.egress]: e });
    this.hubStatusSoon();
    return e;
  }

  /** Имя и адрес хаба из адреса запуска клона (FLEET-SPEC §6). */
  private async onIdentity(tabId: number, profileId: string, hubUrl: string): Promise<void> {
    const cur = this.cfg.profileId;
    const changes: Record<string, string> = {};
    if (profileId && profileId !== cur) {
      if (this.os.armed) this.log(tabId, 'IDENTITY', `адрес запуска просит имя ${profileId}, но профиль ${cur} в гонке — игнорирую`, 'warn');
      else { changes[K.profileId] = profileId; this.log(tabId, 'IDENTITY', cur ? `переименован ${cur} → ${profileId}` : `профиль назначен: ${profileId}`); }
    }
    if (hubUrl && hubUrl !== this.cfg.hubUrl) {
      if (this.os.armed) this.log(tabId, 'IDENTITY', 'адрес хаба в адресе запуска другой, но профиль в гонке — игнорирую', 'warn');
      else { changes[K.hubUrl] = hubUrl; this.log(tabId, 'IDENTITY', `хаб: ${maskUrl(hubUrl)}`); }
    }
    if (Object.keys(changes).length) {
      await chrome.storage.local.set(changes);
      await this.reloadConfig();
    }
    if (!this.os.armed && this.cfg.hubUrl) await this.fetchConfigFromHub('identity');
    await this.maybeAutoStart('identity');
  }

  /** Конфиг профиля с хаба (FLEET-SPEC §9.2). Никогда не блокирует Start: таймаут 5 с, при ошибке — сохранённый конфиг. */
  async fetchConfigFromHub(reason: string): Promise<{ ok: boolean; error?: string; version?: number }> {
    if (this.fetching) return this.fetching;
    this.fetching = this.doFetchConfig(reason).finally(() => { this.fetching = null; });
    return this.fetching;
  }

  private async doFetchConfig(reason: string): Promise<{ ok: boolean; error?: string; version?: number }> {
    const url = configUrlFromHub(this.cfg.hubUrl, this.cfg.profileId);
    if (!url) return { ok: false, error: this.cfg.hubUrl ? 'профиль не назначен' : 'хаб не задан' };
    try {
      const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(CONFIG_FETCH_MS) });
      const j = (await r.json().catch(() => null)) as Record<string, unknown> | null;
      if (r.status === 404) { this.log('sw', 'CONFIG', `хаб не знает профиль ${this.cfg.profileId} — проверь fleet.json`, 'warn'); return { ok: false, error: `хаб не знает профиль ${this.cfg.profileId}` }; }
      if (r.status === 422 || Array.isArray(j?.errors)) {
        const errs = Array.isArray(j?.errors) ? (j!.errors as string[]).join('; ') : `HTTP ${r.status}`;
        this.log('sw', 'CONFIG', `конфиг профиля на хабе с ошибками: ${errs}`, 'warn');
        return { ok: false, error: errs };
      }
      if (!r.ok || !j) { this.log('sw', 'CONFIG', `хаб ответил HTTP ${r.status} на запрос конфига`, 'warn'); return { ok: false, error: `HTTP ${r.status}` }; }
      const cfg = normalizeConfig(j);
      cfg.profileId = this.cfg.profileId;
      cfg.hubUrl = this.cfg.hubUrl;
      if (this.os.armed) {
        this.cfgPending = cfg.version;
        this.log('sw', 'CONFIG', `конфиг v${cfg.version} с хаба получен, но профиль в гонке — применю при следующем Start`);
        this.hubStatusSoon();
        return { ok: false, error: 'профиль в гонке', version: cfg.version };
      }
      const meta: CfgMeta = { version: cfg.version, hash: cfg.cfgHash, receivedAt: Date.now(), source: reason };
      await chrome.storage.local.set({ [K.config]: cfg, [K.cfgMeta]: meta });
      await chrome.storage.local.remove(K.modeOverride);
      this.cfgMeta = meta;
      this.cfgPending = undefined;
      await this.reloadConfig();
      this.log('sw', 'CONFIG', `конфиг v${cfg.version} с хаба (${reason})${cfg.cfgHash ? ` · ${cfg.cfgHash.slice(0, 8)}` : ''}`);
      return { ok: true, version: cfg.version };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log('sw', 'CONFIG', `хаб недоступен (${msg}) — работаю с сохранённым конфигом v${this.cfg.version}`, 'warn');
      return { ok: false, error: msg, version: this.cfg.version };
    }
  }

  /** autoStart (FLEET-SPEC §5.4): один раз на openAt, не после оформленного заказа и не после ручного Stop. */
  async maybeAutoStart(reason: string): Promise<void> {
    if (!this.cfg.autoStart || !this.cfg.profileId || this.os.armed || this.autoStarting) return;
    this.autoStarting = true;
    try {
      const l = await chrome.storage.local.get([K.autoStarted, 'orders']);
      if (l[K.autoStarted] === this.cfg.openAt) return;
      const orders = Array.isArray(l.orders) ? (l.orders as OrderRecord[]) : [];
      if (orders.some((r) => r.profileId === this.cfg.profileId && r.status === 'ORDERED' && r.openAt === this.cfg.openAt)) {
        this.log('sw', 'AUTOSTART', 'заказ для этого openAt уже оформлен — гонку заново не начинаю');
        await chrome.storage.local.set({ [K.autoStarted]: this.cfg.openAt });
        return;
      }
      const v = validateConfig(this.cfg);
      if (v.errors.length) { this.log('sw', 'AUTOSTART', `конфиг с ошибками, автостарт отменён: ${v.errors.join('; ')}`, 'warn'); return; }
      await chrome.storage.local.set({ [K.autoStarted]: this.cfg.openAt });
      this.log('sw', 'AUTOSTART', `autoStart (${reason}) — выполняю Start`);
      const r = (await this.start('auto')) as { ok: boolean; error?: string };
      if (!r.ok) this.log('sw', 'AUTOSTART', `Start не удался: ${r.error}`, 'warn');
    } finally {
      this.autoStarting = false;
    }
  }

  // ---------- команды popup / хаба ----------
  async onCommand(c: Cmd): Promise<unknown> {
    await this.ready;
    switch (c.cmd) {
      case 'status': return this.status();
      case 'start': return this.start(c.source ?? 'popup');
      case 'stop': return this.stop();
      case 'prepare': return this.openSpecial('prep');
      case 'cleanBag': return this.openSpecial('clean');
      case 'toggleAssist': {
        const mode = this.cfg.mode === 'assist' ? 'auto' : 'assist';
        await chrome.storage.local.set({ [K.modeOverride]: mode });
        await this.reloadConfig();
        return { ok: true, mode };
      }
      case 'setStrategy': return this.setStrategy(c.strategy);
      case 'checkIp': return { ok: true, egress: await this.checkIp() };
      case 'fetchConfig': return this.fetchConfigFromHub('popup');
      case 'focus': {
        const id = this.os.winnerTabId ?? this.os.raceTabs.find((x) => this.tabs.has(x)) ?? [...this.tabs.keys()][0];
        return { ok: id !== undefined && (await focusTab(id)) };
      }
      case 'exportLog': await this.logs.flush(); return { ok: true, text: this.logs.all().join('\n') };
      case 'exportOrders': return { ok: true, text: await this.ordersCsv() };
      case 'clearLog': await this.logs.clear(); return { ok: true };
      case 'focusTab': return { ok: await focusTab(c.tabId) };
      case 'reloadConfig': await this.reloadConfig(); return { ok: true };
    }
    return { ok: false, error: 'unknown command' };
  }

  private async setStrategy(strategy: Strategy): Promise<unknown> {
    const s = await chrome.storage.local.get(K.config);
    const cfg = normalizeConfig(s[K.config]);
    cfg.strategy = strategy;
    await chrome.storage.local.set({ [K.config]: cfg });
    await this.reloadConfig();
    this.log('sw', 'STRATEGY', `стратегия → ${strategy} (с этого момента)`);
    return { ok: true, strategy };
  }

  private async status(): Promise<unknown> {
    const s = await chrome.storage.local.get([K.prepared, 'orders']);
    return {
      ok: true,
      profileId: this.cfg.profileId,
      server: serverOf(this.cfg.profileId),
      mode: this.cfg.mode,
      strategy: this.cfg.strategy,
      autoStart: this.cfg.autoStart,
      openAt: this.cfg.openAt,
      baseUrl: this.cfg.baseUrl,
      mock: isMockBase(this.cfg.baseUrl),
      order: this.order ? { id: this.order.id, targets: this.order.targets.map((p) => `${p} ${partLabel(p)}`), stores: this.order.stores, payment: this.order.payment, racers: this.order.racersPerProfile } : null,
      os: this.os,
      tabs: this.rows(),
      hub: { url: maskUrl(this.cfg.hubUrl), connected: this.hub.connected },
      cfg: { version: this.cfg.version, hash: this.cfg.cfgHash, meta: this.cfgMeta, pending: this.cfgPending },
      proxy: this.cfg.proxy ? { label: proxyLabel(this.cfg.proxy) } : null,
      egress: this.egress,
      payQueue: this.payQueue,
      payActive: this.payActive,
      prepared: s[K.prepared] ?? null,
      orders: Array.isArray(s.orders) ? (s.orders as OrderRecord[]).slice(-10) : [],
      validation: validateConfig(this.cfg),
      log: this.logs.tail(60),
    };
  }

  private async start(source: string): Promise<unknown> {
    // конфиг с хаба перед каждым Start (5 с, не блокирует); autoStart после IDENTITY конфиг уже получил
    if (source !== 'auto' && this.cfg.hubUrl && this.cfg.profileId) await this.fetchConfigFromHub('start');
    this.cfg = await loadConfig();
    this.order = orderFor(this.cfg) ?? null;
    const v = validateConfig(this.cfg);
    if (v.errors.length) return { ok: false, error: v.errors.join('\n') };
    const o = this.order;
    if (!o) return { ok: false, error: `профиль ${this.cfg.profileId} не назначен ни одному заказу` };
    if (isMockBase(this.cfg.baseUrl) && !(await this.mockAlive())) {
      return { ok: false, error: `Мок-сервер ${this.cfg.baseUrl} не запущен — вкладки открывать бессмысленно.\nСухой прогон: в Терминале ./run-mock.command (нужен Node.js).\nЖивой тест: Настройки → baseUrl = https://www.apple.com (и боевая сборка, не extension-dev).` };
    }
    await this.syncProxy('Start');
    const target = o.targets[0];
    this.os = { ...newOrderState(), armed: true, startedAt: Date.now(), activeTarget: target };
    this.payQueue = [];
    this.payActive = null;
    await this.savePay();
    const want = Math.min(o.racersPerProfile, this.cfg.limits.maxTabsTotal);
    // переиспользуем живые вкладки: ту, с которой запущен клон (FLEET-SPEC §5.4), и вкладки прошлого Start
    const reuse = [...this.tabs.values()].filter((t) => t.mode === 'idle' && t.port && /\/shop\/buy-iphone\//.test(t.url ?? '')).slice(0, want);
    for (const t of reuse) {
      this.os.raceTabs.push(t.tabId);
      this.sendTab(t.tabId, { t: 'MODE', mode: 'race', extra: { ...newTabState('race'), target } });
    }
    const n = want - reuse.length;
    if (n > 0) {
      const url = partUrl(this.cfg.baseUrl, target);
      const win = reuse.length
        ? { tabs: await Promise.all(Array(n).fill(0).map(() => chrome.tabs.create({ url, windowId: reuse[0].windowId, active: false }))) }
        : await chrome.windows.create({ url: Array(n).fill(url), focused: true });
      for (const tab of win?.tabs ?? []) {
        if (tab.id === undefined) continue;
        this.os.raceTabs.push(tab.id);
        this.keepTab(tab.id);
        await this.initTab(tab.id, newTabState('race', { target, lastTargetNavAt: Date.now() }));
      }
    }
    for (const t of reuse) this.keepTab(t.tabId);
    await this.saveOs(true);
    this.tabTickAt = 0;
    this.ensureSwWatch();
    this.log('sw', 'START', `${source}: ${want} вкладок (${reuse.length} переиспользовано), цель ${partLabel(target)}, openAt ${this.cfg.openAt}, стратегия ${this.cfg.strategy}, режим ${this.cfg.mode}, конфиг v${this.cfg.version}`);
    if (this.hub.connected) this.register();
    assignRoles(this);
    return { ok: true, warnings: v.warnings };
  }

  private async mockAlive(): Promise<boolean> {
    try {
      const r = await fetch(`${this.cfg.baseUrl}/__state`, { cache: 'no-store', signal: AbortSignal.timeout(2500) });
      return r.ok;
    } catch {
      return false;
    }
  }

  private async stop(): Promise<unknown> {
    this.os.armed = false;
    await this.saveOs(true);
    this.broadcast({ t: 'STOP', reason: 'Stop' }, (t) => t.mode !== 'idle');
    this.payQueue = [];
    this.payActive = null;
    await this.savePay();
    this.log('sw', 'STOP', 'остановлено');
    assignRoles(this);
    this.ensureSwWatch();
    if (this.cfgPending) void this.fetchConfigFromHub('after-stop');
    return { ok: true };
  }

  private async openSpecial(kind: 'prep' | 'clean'): Promise<unknown> {
    const o = this.order;
    if (kind === 'prep' && !o) return { ok: false, error: 'профиль не назначен заказу' };
    const url = kind === 'prep' ? `${this.cfg.baseUrl}/ae/` : `${this.cfg.baseUrl}/ae/shop/bag`;
    const tab = await chrome.tabs.create({ url, active: true });
    if (tab.id === undefined) return { ok: false };
    this.keepTab(tab.id);
    await this.initTab(tab.id, newTabState(kind, kind === 'prep' ? { prepPhase: 'home', target: o!.targets[0] } : {}));
    this.log(tab.id, kind === 'prep' ? 'PREP' : 'CLEANUP', kind === 'prep' ? 'Prepare: прогрев профиля' : 'Clean bag');
    return { ok: true, tabId: tab.id };
  }
}
