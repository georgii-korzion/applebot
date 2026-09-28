// Оркестратор профиля (§5.1): конфиг, состояние заказа, лок Add to Bag, победитель, очередь оплаты, хаб.
import { K, loadConfig, orderFor, validateConfig, type Config, type OrderCfg } from '../shared/config';
import { LogStore, fmtLine, scrub } from '../shared/log';
import {
  newOrderState, newTabState,
  type C2S, type Cmd, type Hub2S, type Mode, type OrderState, type Role, type S2C, type TabRow, type TabState,
} from '../shared/messages';
import { partLabel, partUrl, storeName } from '../shared/parts';
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
        if ((m.state === 'REVIEW' || m.state === 'ORDERED') && tabId === this.payActive) void this.advancePay(m.state);
        this.hubStatusSoon();
        break;
      }
      case 'LOG':
        this.log(tabId, m.state ?? t.state, m.msg, m.level);
        break;
      case 'OPEN':
        await this.onOpen(m.source, m.buyable, false);
        break;
      case 'WATCH': {
        const at = Date.now();
        this.os.watch = Object.fromEntries(Object.entries(m.statuses).map(([p, s]) => [p, { ...s, at }]));
        const txt = Object.entries(m.statuses).map(([p, s]) => `${p} ${s.isBuyable ? 'BUYABLE' : s.reason ?? '?'}${s.quote ? ` «${s.quote}»` : ''}`).join('; ');
        this.log(tabId, 'WATCH', `${txt}${m.pickup ? ` | pickup ${m.pickup}` : ''}`);
        void this.saveOs();
        break;
      }
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
          this.log(tabId, 'BAG', `корзина не подтверждена: ${m.detail}`, 'warn');
          Object.assign(this.os, { inBag: false, inBagVerified: false, winnerTabId: undefined, decision: undefined, lock: undefined });
          await this.saveOs(true);
        }
        break;
      case 'BILLING_READY':
        await this.onBillingReady(tabId, m.store, m.slotLabel, m.method);
        break;
      case 'ORDERED':
        this.os.orderNo = m.orderNo;
        this.os.stage = 'ORDERED';
        this.os.timestamps.ordered = Date.now();
        await this.saveOs();
        this.log(tabId, 'ORDERED', `номер заказа ${m.orderNo}`);
        void notify({ id: `ordered-${tabId}`, title: `Заказ ${this.order?.id}: оформлен ✅`, message: m.orderNo, tabId, sound: 'done', sticky: true });
        if (this.order) this.hub.send({ t: 'ORDERED', orderId: this.order.id, profile: this.cfg.profileId, orderNo: m.orderNo });
        if (tabId === this.payActive) await this.advancePay('ORDERED');
        break;
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
      case 'PING':
        break;
    }
  }

  onTabRemoved(tabId: number): void {
    const t = this.tabs.get(tabId);
    this.tabs.delete(tabId);
    this.pendingCmds.delete(tabId);
    forgetTab(tabId);
    void chrome.storage.session.remove(K.tab(tabId));
    if (!t) return;
    if (tabId === this.os.winnerTabId && t.mode === 'checkout' && this.os.stage !== 'ORDERED') this.onWinnerFailed(tabId, 'вкладка закрыта');
    if (tabId === this.payActive) void this.advancePay('closed');
    this.payQueue = this.payQueue.filter((p) => p.tabId !== tabId);
    assignRoles(this);
  }

  /** Вкладка ушла с /ae/ (выбор страны увёл на другой регион) — вернуть (§7.5). */
  onTabUpdated(tabId: number, url: string | undefined): void {
    if (!url) return;
    const t = this.tabs.get(tabId);
    // только гонка и прогрев: в чекауте возможны 3-D Secure и действия человека — не вмешиваемся
    if (!t || !['race', 'prep'].includes(t.mode)) return;
    let u: URL;
    try { u = new URL(url); } catch { return; }
    const ours = u.hostname.endsWith('apple.com') || url.startsWith(this.cfg.baseUrl);
    if (!ours || u.pathname.toLowerCase().startsWith('/ae')) { this.awayCount.delete(tabId); return; }
    const n = (this.awayCount.get(tabId) ?? 0) + 1;
    this.awayCount.set(tabId, n);
    this.log(tabId, 'COUNTRY', `вкладка ушла с /ae/: ${u.pathname} (${n})`, 'warn');
    if (n > 3) {
      void notify({ title: `Заказ ${this.order?.id}: регион`, message: 'Вкладку уводит с /ae/ — проверь VPN и гео профиля', tabId, sound: 'alert' });
      return;
    }
    const back = t.mode === 'race' && this.order ? partUrl(this.cfg.baseUrl, this.os.activeTarget ?? this.order.targets[0]) : `${this.cfg.baseUrl}/ae/`;
    void chrome.tabs.update(tabId, { url: back });
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
    if (this.os.decision === 'go') this.sendTab(w, { t: 'GO_BAG' });
    else if (this.os.decision === 'standby') this.sendTab(w, { t: 'STANDBY', holdSec: this.cfg.timing.holdLoserBagSec });
  }

  private onWinnerFailed(tabId: number, reason: string): void {
    this.log(tabId, 'FAILED', `победитель упал на чекауте: ${reason}`, 'warn');
    if (this.order && this.hub.connected) this.hub.send({ t: 'FAILED', orderId: this.order.id, profile: this.cfg.profileId, reason });
    void notify({ title: `Заказ ${this.order?.id}: чекаут остановился`, message: reason, tabId, sound: 'alert' });
  }

  // ---------- очередь оплаты (§7.7) ----------
  private async onBillingReady(tabId: number, store: string, slotLabel: string, method: string): Promise<void> {
    Object.assign(this.os, { stage: 'BILLING_READY', store, slotLabel, billingReadyAt: Date.now() });
    this.os.timestamps.billing = Date.now();
    await this.saveOs();
    const took = this.os.openedAt ? ` (${((Date.now() - this.os.openedAt) / 1000).toFixed(1)} с от OPEN)` : '';
    this.log(tabId, 'BILLING_READY', `${storeName(store)} · ${slotLabel} · ${method}${took}`);
    const item: PayItem = { tabId, orderId: this.order?.id ?? '?', priority: this.order?.priority ?? 99, readyAt: Date.now(), store, slotLabel };
    if (this.hub.connected && this.order) {
      this.hub.send({ t: 'PAY_READY', orderId: item.orderId, profile: this.cfg.profileId, priority: item.priority, store, slotLabel, readyAt: item.readyAt });
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
        if (m.takeover && this.os.winnerTabId !== undefined && this.tabs.get(this.os.winnerTabId)?.mode === 'idle') {
          // корзина уже очищена — гонка заново
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
      case 'clearLog': await this.logs.clear(); return { ok: true };
      case 'focusTab': return { ok: await focusTab(c.tabId) };
      case 'reloadConfig': await this.reloadConfig(); return { ok: true };
    }
    return { ok: false, error: 'unknown command' };
  }

  private async status(): Promise<unknown> {
    const s = await chrome.storage.local.get(K.prepared);
    return {
      ok: true,
      profileId: this.cfg.profileId,
      mode: this.cfg.mode,
      openAt: this.cfg.openAt,
      order: this.order ? { id: this.order.id, targets: this.order.targets.map((p) => `${p} ${partLabel(p)}`), stores: this.order.stores, payment: this.order.payment, racers: this.order.racersPerProfile } : null,
      os: this.os,
      tabs: this.rows(),
      hub: { url: this.cfg.hubUrl, connected: this.hub.connected, watcher: this.watcherProfile },
      payQueue: this.payQueue,
      payActive: this.payActive,
      prepared: s[K.prepared] ?? null,
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
        await this.initTab(tab.id, newTabState('race', { target }));
      }
    }
    await this.saveOs(true);
    this.log('sw', 'START', `заказ ${o.id}: ${want} вкладок (${reuse.length} переиспользовано), цель ${partLabel(target)}, openAt ${this.cfg.openAt}, режим ${this.cfg.mode}`);
    if (this.hub.connected) this.register();
    assignRoles(this);
    return { ok: true, warnings: v.warnings };
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
    return { ok: true };
  }

  private async openSpecial(kind: 'prep' | 'clean'): Promise<unknown> {
    const o = this.order;
    if (kind === 'prep' && !o) return { ok: false, error: 'профиль не назначен заказу' };
    const url = kind === 'prep' ? `${this.cfg.baseUrl}/ae/` : `${this.cfg.baseUrl}/ae/shop/bag`;
    const tab = await chrome.tabs.create({ url, active: true });
    if (tab.id === undefined) return { ok: false };
    await this.initTab(tab.id, newTabState(kind, kind === 'prep' ? { prepPhase: 'home', target: o!.targets[0] } : {}));
    this.log(tab.id, kind === 'prep' ? 'PREP' : 'CLEANUP', kind === 'prep' ? 'Prepare: прогрев профиля' : 'Clean bag');
    return { ok: true, tabId: tab.id };
  }
}
