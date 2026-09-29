// Оркестратор профиля (§5.1): конфиг, состояние заказа, лок Add to Bag, победитель, очередь оплаты, хаб.
import { K, closedReloadMs, isMockBase, loadConfig, orderFor, validateConfig, type Config, type OrderCfg } from '../shared/config';
import { LogStore, fmtLine, scrub } from '../shared/log';
import {
  newOrderState, newTabState,
  type C2S, type Cmd, type Hub2S, type Mode, type OrderRecord, type OrderState, type Role, type S2C, type TabRow, type TabState,
} from '../shared/messages';
import { partLabel, partUrl, storeName } from '../shared/parts';
import { pollFm } from '../shared/watch';
import { HubClient } from './hubClient';
import { notify, playSound } from './notify';
import { focusTab } from './windows';
import { assignRoles, computeRoles } from './watcher';
import { forgetTab, recent } from './diag';

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

export class Orchestrator {
  cfg!: Config;
  order: OrderCfg | null = null;
  os: OrderState = newOrderState();
  tabs = new Map<number, TabInfo>();
  logs = new LogStore();
  hub: HubClient;
  watcherProfile: string | null = null;
  payQueue: PayItem[] = [];
  payActive: number | null = null;
  ready: Promise<void>;

  private pendingInit = new Map<number, TabState>();
  private pendingCmds = new Map<number, S2C[]>();
  private decisionTimer: ReturnType<typeof setTimeout> | undefined;
  private statusTimer: ReturnType<typeof setTimeout> | undefined;
  private awayCount = new Map<number, number>();
  private awayTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private storeNotifiedAt = 0;
  private tabTickAt = 0;
  private swWatchTimer: ReturnType<typeof setTimeout> | undefined;
  private swWatchErrors = 0;
  private swWatchBusy = false;

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
    this.hub.setUrl(this.cfg.hubUrl);
    this.ensureSwWatch();
  }

  /** Вкладку гонки/чекаута Chrome не должен выгружать (Memory Saver): content script там — вся логика. */
  private keepTab(tabId: number): void {
    chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
  }

  // ---------- утилиты ----------
  log(tab: number | string, state: string, msg: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    const line = fmtLine({
      ts: Date.now(), openedAt: this.os.openedAt, openAt: Date.parse(this.cfg?.openAt ?? ''),
      profile: this.cfg?.profileId ?? '?', order: this.order?.id ?? '-', tab, state, msg: scrub(msg), level,
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
        // следующий на оплату — только после номера заказа или кнопки «Следующий»: Review теперь открывает само расширение
        if (m.state === 'ORDERED' && tabId === this.payActive) void this.advancePay(m.state);
        this.hubStatusSoon();
        break;
      }
      case 'LOG':
        this.log(tabId, m.state ?? t.state, m.msg, m.level);
        break;
      case 'OPEN':
        await this.onOpen(m.source, m.buyable, false);
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
        this.log(tabId, 'ORDERED', `номер заказа ${m.orderNo}`);
        void notify({ id: `ordered-${tabId}`, title: `Заказ ${this.order?.id}: оформлен ✅`, message: m.orderNo, tabId, sound: 'done', sticky: true });
        const rec = await this.recordOrder({ orderNo: m.orderNo, orderedAt: Date.now(), status: 'ORDERED' });
        if (this.order) this.hub.send({ t: 'ORDERED', orderId: this.order.id, profile: this.cfg.profileId, orderNo: m.orderNo, record: rec });
        if (tabId === this.payActive) await this.advancePay('ORDERED');
        break;
      }
      case 'ASSIST':
        this.log(tabId, 'ASSIST', `${m.step}: ${m.msg}`, 'warn');
        await focusTab(tabId);
        void notify({ id: `assist-${tabId}`, title: `Заказ ${this.order?.id}: нужен клик`, message: m.msg, tabId, sound: 'assist', sticky: true });
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
      if (n > 3) void notify({ title: `Профиль ${this.cfg.profileId}: регион`, message: 'Вкладку уводит с /ae/ — проверь VPN и гео профиля', tabId, sound: 'alert' });
      else void chrome.tabs.update(tabId, { url: `${this.cfg.baseUrl}/ae/` });
      return;
    }
    if (!this.os.armed || !this.order) return;
    if (n === 2) void this.onStore(tabId, true, `редирект вне /ae/: ${u.pathname}`);
    if (n === 3) void notify({ id: `away-${tabId}`, title: `Заказ ${this.order.id}: вкладку уводит с /ae/`, message: 'Возвращаю на страницу товара по расписанию. Если это не закрытие магазина — проверь VPN/гео.', tabId });
    this.scheduleBack(tabId, n === 1 ? 0 : closedReloadMs(this.cfg, this.os.openedAt));
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
      this.log(tabId, 'CLOSED', `Apple Store закрыт (${reason}) — вкладки обновляются по фазам, пока не пустит`, 'warn');
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
  // Основной наблюдатель живёт во вкладке (§7.3, запросы same-origin). Скрытую вкладку Chrome тормозит
  // (таймеры, Memory Saver), поэтому SW опрашивает сам, пока вкладка не подтверждает тиками, что жива.
  ensureSwWatch(): void {
    const me = this.cfg.profileId;
    const otherWatches = this.hub.connected && !!this.watcherProfile && this.watcherProfile !== me;
    const should = this.os.armed && !this.os.openedAt && !!this.order && !otherWatches;
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
        const targets = [...new Set([...this.order.targets, ...(this.os.watchTargets ?? [])])];
        try {
          const r = await pollFm(this.cfg.baseUrl, targets, this.order.stores);
          this.swWatchErrors = 0;
          this.recordWatch('sw', r.statuses, r.pickup, 'sw');
          if (this.os.watcherTabId !== undefined) this.sendTab(this.os.watcherTabId, { t: 'SW_WATCH', at: Date.now(), ok: true }, false);
          if (r.buyable.length) await this.onOpen('sw-json', r.buyable, false);
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

  // ---------- OPEN ----------
  async onOpen(source: string, buyable: string[], fromHub: boolean): Promise<void> {
    if (this.os.openedAt) return;
    this.os.openedAt = Date.now();
    this.os.openSource = source;
    this.os.timestamps.open = this.os.openedAt;
    const targets = this.order?.targets ?? [];
    const first = targets.find((p) => buyable.includes(p)) ?? this.os.activeTarget ?? targets[0];
    this.os.activeTarget = first;
    this.log('sw', 'OPEN', `продажи открыты (${source}${fromHub ? ' via hub' : ''}), buyable: ${buyable.join(',') || '—'} → цель ${first ? partLabel(first) : '—'}`);
    await this.saveOs();
    this.broadcast({ t: 'OPEN', activeTarget: first });
    if (!fromHub) this.hub.send({ t: 'OPEN', profile: this.cfg.profileId, buyable, source });
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

  // ---------- победитель (§7.1) ----------
  private async onBagOk(tabId: number, detail: string): Promise<void> {
    const os = this.os;
    if (os.inBagVerified && os.winnerTabId !== undefined && os.winnerTabId !== tabId && this.tabs.has(os.winnerTabId)) {
      this.sendTab(tabId, { t: 'STOP', reason: `победитель уже есть (вкладка ${os.winnerTabId})` });
      return;
    }
    const first = os.winnerTabId !== tabId || !os.inBagVerified;
    Object.assign(os, { winnerTabId: tabId, inBag: true, inBagVerified: true, lock: undefined });
    os.inBagAt ??= Date.now();
    if (first) {
      this.log(tabId, 'IN_BAG', `товар в корзине профиля: ${detail}`);
      for (const t of this.tabs.values()) {
        if (t.tabId !== tabId && t.mode === 'race') this.sendTab(t.tabId, { t: 'STOP', reason: `товар в корзине (вкладка ${tabId})` });
      }
      if (this.hub.connected && this.order) {
        os.decision = 'pending';
        this.hub.send({ t: 'WIN_REQ', orderId: this.order.id, profile: this.cfg.profileId });
        clearTimeout(this.decisionTimer);
        this.decisionTimer = setTimeout(() => {
          if (this.os.decision !== 'pending') return;
          this.log('sw', 'HUB', 'хаб не ответил на WIN_REQ за 3 с — продолжаю сам', 'warn');
          this.os.decision = 'go';
          void this.saveOs(true);
          this.sendDecision();
        }, 3000);
      } else os.decision = 'go';
    }
    await this.saveOs(true);
    this.sendDecision();
  }

  private sendDecision(): void {
    const w = this.os.winnerTabId;
    if (w === undefined) return;
    if (this.os.decision === 'go') {
      this.sendTab(w, { t: 'GO_BAG' });
      // видимая вкладка не тормозится браузером — чекаут идёт быстрее (окно не перехватываем, только вкладка)
      chrome.tabs.update(w, { active: true }).catch(() => {});
    }
    else if (this.os.decision === 'standby') this.sendTab(w, { t: 'STANDBY', holdSec: this.cfg.timing.holdLoserBagSec });
  }

  private onWinnerFailed(tabId: number, reason: string): void {
    this.log(tabId, 'FAILED', `победитель упал на чекауте: ${reason}`, 'warn');
    if (this.order && this.hub.connected) this.hub.send({ t: 'FAILED', orderId: this.order.id, profile: this.cfg.profileId, reason });
    void notify({ title: `Заказ ${this.order?.id}: чекаут остановился`, message: reason, tabId, sound: 'alert' });
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
      payment: o.payment, openedAt: this.os.openedAt, billingAt: this.os.billingReadyAt ?? Date.now(), status: 'BILLING_READY',
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
    return '\uFEFF' + [head.map(esc).join(';'), ...rows].join('\n');
  }

  // ---------- очередь оплаты (§7.7) ----------
  private async onBillingReady(tabId: number, store: string, slotLabel: string, method: string, price?: string, cardFilled?: boolean): Promise<void> {
    Object.assign(this.os, { stage: 'BILLING_READY', store, slotLabel, billingReadyAt: Date.now() });
    this.os.timestamps.billing = Date.now();
    await this.saveOs();
    const took = this.os.openedAt ? ` (${((Date.now() - this.os.openedAt) / 1000).toFixed(1)} с от OPEN)` : '';
    this.log(tabId, 'BILLING_READY', `${storeName(store)} · ${slotLabel} · ${method}${price ? ` · ${price}` : ''}${cardFilled ? ' · карта заполнена' : ''}${took}`);
    const rec = await this.recordOrder({ price, billingAt: Date.now(), status: 'BILLING_READY' });
    const item: PayItem = { tabId, orderId: this.order?.id ?? '?', priority: this.order?.priority ?? 99, readyAt: Date.now(), store, slotLabel };
    if (this.hub.connected && this.order) {
      this.hub.send({ t: 'PAY_READY', orderId: item.orderId, profile: this.cfg.profileId, priority: item.priority, store, slotLabel, readyAt: item.readyAt, record: rec });
      return;
    }
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
    const label = `Заказ ${o?.id ?? '?'}: ${what}`;
    this.log(tabId, 'PAYING', `на оплату: ${storeName(this.os.store)} · ${this.os.slotLabel ?? ''}`);
    this.sendTab(tabId, { t: 'FOCUS_FOR_PAY', label });
    await focusTab(tabId);
    void notify({ id: `pay-${tabId}`, title: label, message: `${storeName(this.os.store)} · ${this.os.slotLabel ?? ''}`, tabId, sound: 'pay', sticky: true });
  }

  async advancePay(reason: string): Promise<void> {
    if (this.hub.connected && this.order) {
      this.hub.send({ t: 'PAY_DONE', orderId: this.order.id, profile: this.cfg.profileId, stage: reason });
      this.payActive = null;
      await this.savePay();
      return;
    }
    this.payActive = null;
    await this.activatePay();
  }

  // ---------- хаб ----------
  private onHubState(connected: boolean): void {
    this.log('sw', 'HUB', connected ? `подключён ${this.hub.address}` : 'отключён', connected ? 'info' : 'warn');
    if (connected) this.register();
    else this.watcherProfile = null;
    assignRoles(this);
    this.ensureSwWatch();
    this.broadcast({ t: 'OS', os: this.os }, (t) => !!t.port);
  }

  private register(): void {
    this.hub.send({
      t: 'REGISTER', profile: this.cfg.profileId, orderId: this.order?.id ?? null, priority: this.order?.priority ?? 99,
      tabs: this.order?.racersPerProfile ?? 0, targets: this.order?.targets ?? [],
    });
    this.hubStatusSoon();
  }

  private onHub(m: Hub2S): void {
    const me = this.cfg.profileId;
    switch (m.t) {
      case 'WATCHER':
        this.watcherProfile = m.profile;
        if (m.profile === me && m.targets) { this.os.watchTargets = m.targets; void this.saveOs(true); }
        assignRoles(this);
        this.ensureSwWatch();
        break;
      case 'OPEN':
        void this.onOpen(m.source, m.buyable, true);
        break;
      case 'WIN':
        if (m.profile !== me || m.orderId !== this.order?.id) break;
        clearTimeout(this.decisionTimer);
        this.log('sw', 'HUB', m.takeover ? 'TAKEOVER: победитель упал, заказ передан этому профилю' : 'WIN: этот профиль ведёт заказ');
        this.os.decision = 'go';
        void this.saveOs(true);
        if (m.takeover && this.os.winnerTabId !== undefined && ['idle', 'clean'].includes(this.tabs.get(this.os.winnerTabId)?.mode ?? '')) {
          // корзина уже очищена (или чистится) — гонка заново
          this.sendTab(this.os.winnerTabId, { t: 'MODE', mode: 'race', extra: { state: 'INIT', target: this.os.activeTarget } });
          Object.assign(this.os, { inBag: false, inBagVerified: false, winnerTabId: undefined });
        } else this.sendDecision();
        if (m.takeover) void notify({ title: `Заказ ${this.order?.id}: TAKEOVER`, message: 'Этот профиль продолжает заказ', sound: 'alert' });
        break;
      case 'LOSE':
        if (m.orderId !== this.order?.id) break;
        clearTimeout(this.decisionTimer);
        this.log('sw', 'HUB', `LOSE: заказ ведёт другой профиль — STANDBY, держим товар ${this.cfg.timing.holdLoserBagSec} с`);
        this.os.decision = 'standby';
        void this.saveOs(true);
        this.sendDecision();
        break;
      case 'CLEAN':
        if (m.orderId !== this.order?.id || this.os.decision !== 'standby' || this.os.winnerTabId === undefined) break;
        this.log('sw', 'HUB', 'победитель на Billing — чищу корзину запаса');
        this.sendTab(this.os.winnerTabId, { t: 'CLEAN' });
        break;
      case 'PAY_TURN':
        if (m.profile !== me || this.os.winnerTabId === undefined) break;
        this.payActive = this.os.winnerTabId;
        void this.savePay();
        void this.focusForPay(this.os.winnerTabId);
        break;
      case 'PONG':
        break;
    }
  }

  private hubStatusSoon(): void {
    if (!this.hub.connected || this.statusTimer) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = undefined;
      this.hub.send({ t: 'STATUS', profile: this.cfg.profileId, orderId: this.order?.id ?? null, stage: this.os.stage, tabs: this.rows(), openedAt: this.os.openedAt });
    }, 400);
  }

  rows(): TabRow[] {
    return [...this.tabs.values()].sort((a, b) => a.tabId - b.tabId).map((t) => ({
      tabId: t.tabId, role: t.role, mode: t.mode, state: t.state, detail: t.detail, outcome: t.outcome,
      url: t.url ? new URL(t.url).pathname : '', reloads: t.reloads, atb404: t.atb404, updatedAt: t.updatedAt,
    }));
  }

  // ---------- конфиг ----------
  async reloadConfig(): Promise<void> {
    this.cfg = await loadConfig();
    this.order = orderFor(this.cfg) ?? null;
    this.hub.setUrl(this.cfg.hubUrl);
    if (this.hub.connected) this.register();
    this.broadcast({ t: 'CONFIG', cfg: this.cfg, order: this.order }, (t) => !!t.port);
    this.ensureSwWatch();
    this.log('sw', 'CONFIG', `конфиг обновлён: профиль ${this.cfg.profileId}, заказ ${this.order?.id ?? '—'}, режим ${this.cfg.mode}`);
  }

  // ---------- команды popup ----------
  async onCommand(c: Cmd): Promise<unknown> {
    await this.ready;
    switch (c.cmd) {
      case 'status': return this.status();
      case 'start': return this.start();
      case 'stop': return this.stop();
      case 'prepare': return this.openSpecial('prep');
      case 'cleanBag': return this.openSpecial('clean');
      case 'nextPay':
        if (this.hub.connected) this.hub.send({ t: 'NEXT' });
        else await this.advancePay('manual-next');
        this.log('sw', 'PAY', 'следующий на оплату (вручную)');
        return { ok: true };
      case 'toggleAssist': {
        const mode = this.cfg.mode === 'assist' ? 'auto' : 'assist';
        await chrome.storage.local.set({ [K.modeOverride]: mode });
        await this.reloadConfig();
        return { ok: true, mode };
      }
      case 'exportLog': await this.logs.flush(); return { ok: true, text: this.logs.all().join('\n') };
      case 'exportOrders': return { ok: true, text: await this.ordersCsv() };
      case 'clearLog': await this.logs.clear(); return { ok: true };
      case 'focusTab': return { ok: await focusTab(c.tabId) };
      case 'reloadConfig': await this.reloadConfig(); return { ok: true };
    }
    return { ok: false, error: 'unknown command' };
  }

  private async status(): Promise<unknown> {
    const s = await chrome.storage.local.get([K.prepared, 'orders']);
    return {
      ok: true,
      profileId: this.cfg.profileId,
      mode: this.cfg.mode,
      openAt: this.cfg.openAt,
      baseUrl: this.cfg.baseUrl,
      mock: isMockBase(this.cfg.baseUrl),
      order: this.order ? { id: this.order.id, targets: this.order.targets.map((p) => `${p} ${partLabel(p)}`), stores: this.order.stores, payment: this.order.payment, racers: this.order.racersPerProfile } : null,
      os: this.os,
      tabs: this.rows(),
      hub: { url: this.cfg.hubUrl, connected: this.hub.connected, watcher: this.watcherProfile },
      payQueue: this.payQueue,
      payActive: this.payActive,
      prepared: s[K.prepared] ?? null,
      orders: Array.isArray(s.orders) ? (s.orders as OrderRecord[]).slice(-10) : [],
      validation: validateConfig(this.cfg),
      log: this.logs.tail(60),
    };
  }

  private async start(): Promise<unknown> {
    this.cfg = await loadConfig();
    this.order = orderFor(this.cfg) ?? null;
    const v = validateConfig(this.cfg);
    if (v.errors.length) return { ok: false, error: v.errors.join('\n') };
    const o = this.order;
    if (!o) return { ok: false, error: `профиль ${this.cfg.profileId} не назначен ни одному заказу` };
    if (isMockBase(this.cfg.baseUrl) && !(await this.mockAlive())) {
      return { ok: false, error: `Мок-сервер ${this.cfg.baseUrl} не запущен — вкладки открывать бессмысленно.\nСухой прогон: в Терминале ./run-mock.command (нужен Node.js).\nЖивой тест: Настройки → baseUrl = https://www.apple.com (и боевая сборка, не extension-dev).` };
    }
    const target = o.targets[0];
    const keep = this.os.watchTargets;
    this.os = { ...newOrderState(), armed: true, startedAt: Date.now(), activeTarget: target, watchTargets: keep };
    this.payQueue = [];
    this.payActive = null;
    await this.savePay();
    const want = Math.min(o.racersPerProfile, this.cfg.limits.maxTabsTotal);
    // переиспользуем живые вкладки прошлого Start
    const reuse = [...this.tabs.values()].filter((t) => t.mode === 'idle' && t.port && /\/shop\/buy-iphone\//.test(t.url ?? '')).slice(0, want);
    for (const t of reuse) {
      this.os.raceTabs.push(t.tabId);
      this.sendTab(t.tabId, { t: 'MODE', mode: 'race', extra: { ...newTabState('race'), target } });
    }
    const n = want - reuse.length;
    if (n > 0) {
      const url = partUrl(this.cfg.baseUrl, target);
      const win = await chrome.windows.create({ url: Array(n).fill(url), focused: true });
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
    this.log('sw', 'START', `заказ ${o.id}: ${want} вкладок (${reuse.length} переиспользовано), цель ${partLabel(target)}, openAt ${this.cfg.openAt}, режим ${this.cfg.mode}`);
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
    this.broadcast({ t: 'STOP', reason: 'Stop из popup' }, (t) => t.mode !== 'idle');
    this.payQueue = [];
    this.payActive = null;
    await this.savePay();
    this.log('sw', 'STOP', 'остановлено пользователем');
    assignRoles(this);
    this.ensureSwWatch();
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
