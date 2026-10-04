// Хаб бота (BOT-SPEC §3, §6, §9–§13): ядро оркестратора. Принимает расширения по WebSocket (loopback, токен из
// bootstrap.json), раздаёт конфиг и заказы, ведёт пул карт и ворота Place Order, очередь внимания человека,
// сторож зависаний, адаптацию стратегии H1, журнал событий; отдаёт дашборд и API.
// Протокол — надмножество старого хаба (hub/server.mjs остаётся для автономного режима без бота).
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import type { Strategy, ClickTarget, HumanReason } from '../../../src/shared/bot';
import type { Hub2S, OrderRecord, S2Hub } from '../../../src/shared/messages';
import { partLabel, storeName } from '../../../src/shared/parts';
import { scrub } from '../../../src/shared/log';
import { botRuntime, last4, toExtConfig, toExtOrder, type BotConfig, type BotOrder, type PayMethod, type Secrets } from '../config';
import type { Store } from '../store';
import type { Notifier } from '../notify';
import { recipientOut, type NotifyEvent } from '../notify/templates';
import { AttentionQueue, type AttnItem } from './attention';
import { CardPool } from './cards';
import { adaptTick, isStuck, newAdapt, pickOrder, type AdaptState, type OrderState } from './policy';
import { withPage } from '../cdp';
import { beep, osClick } from '../os';
import { dashboardHtml } from '../dashboard/page';

export type BrowserStatus = 'STARTING' | 'RUNNING' | 'DEAD' | 'PROXY_DOWN' | 'RETIRED' | 'STOPPED';

export interface BrowserRt {
  id: string;
  token: string;
  strategy: Strategy;
  startStrategy: Strategy;
  openJitter: boolean;
  proxyId: string | null;
  proxyLabel?: string;
  exitIp?: string;
  pid?: number;
  cdpPort?: number;
  forwarderPort?: number;
  profileDir: string;
  extDir: string;
  status: BrowserStatus;
  launchedAt?: number;
  /** Сторож запуска уже объяснил, почему браузер не подключился. */
  noConnectAt?: number;
  relaunches: number;
  retiredReason?: string;
  // живое
  online: boolean;
  lastBeat: number;
  state: string;
  stateSince: number;
  mode?: string;
  page?: string;
  step?: string;
  path?: string;
  detail?: string;
  lastError?: string;
  reloads: number;
  orderId: string | null;
  role: 'claimer' | 'leader' | 'standby' | 'spare' | null;
  admittedAt?: number;
  admittedStrategy?: Strategy;
  placed: boolean;
  stuck: boolean;
  manual: boolean;
  blocked: boolean;
  payWait?: string;
  ext?: string;
  prepared?: { ok: boolean; detail: string; at: number };
  strategySwitchedAt?: number;
}

export interface OrderRt {
  id: string;
  cfg: BotOrder;
  state: OrderState;
  claimers: string[];
  leader: string | null;
  standby: string[];
  failed: string[];
  method: PayMethod;
  cardId: string | null;
  attempts: number;
  inBagAt?: number;
  billingAt?: number;
  placedAt?: number;
  orderedAt?: number;
  orderNo?: string;
  record?: OrderRecord;
  store?: string;
  slotLabel?: string;
  price?: string;
  notified3ds?: number;
}

export interface FleetOps {
  relaunch(id: string, reason: string, opts: { newProfile: boolean; proxyId?: string | null }): Promise<string | null>;
  kill(id: string): void;
  spareProxy(): string | null;
  activate(id: string): void;
}

interface Persisted {
  version: 1;
  runId: string;
  machine: string;
  startedAt: number;
  dashToken: string;
  openedAt: number | null;
  openSource: string | null;
  browsers: Record<string, Partial<BrowserRt>>;
  orders: Record<string, Partial<OrderRt>>;
  cards: ReturnType<CardPool['snapshot']>;
  adapt: AdaptState;
  nextBrowserNo: number;
  summarySent?: boolean;
  holdExpired?: boolean;
  forwarders?: Record<string, { pid?: number; port: number }>;
}

const LIVE_KEYS: (keyof BrowserRt)[] = ['online', 'lastBeat', 'state', 'stateSince', 'mode', 'page', 'step', 'path', 'detail', 'lastError', 'stuck', 'payWait', 'manual'];

export class Hub {
  browsers = new Map<string, BrowserRt>();
  orders = new Map<string, OrderRt>();
  cards: CardPool;
  attn = new AttentionQueue();
  adapt: AdaptState = newAdapt();
  openedAt: number | null = null;
  openSource: string | null = null;
  dashToken: string;
  runId: string;
  startedAt = Date.now();
  nextBrowserNo = 1;
  watchers: string[] = [];
  fleet: FleetOps | null = null;
  /** Процессы форвардеров прокси (переживают оркестратор): id → PID, порт. */
  forwarders: Record<string, { pid?: number; port: number }> = {};
  /** Статистика форвардеров прокси (лаунчер). */
  proxyStats: () => unknown[] = () => [];
  notifier: Notifier | null = null;
  logTail: string[] = [];
  /** run — гонка; prepare — bot prepare (прогрев профилей, без гонки). */
  mode: 'run' | 'prepare' = 'run';
  private sockets = new Map<string, WebSocket>();
  private dashSockets = new Set<WebSocket>();
  private server: http.Server | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private storeClosedNotified = false;
  private summarySent = false;
  private holdExpired = false;
  private dashDirty = true;
  readonly port: number;

  constructor(readonly cfg: BotConfig, readonly sec: Secrets, readonly store: Store, saved?: Persisted | null) {
    this.port = cfg.hub.port;
    this.dashToken = saved?.dashToken ?? randomBytes(12).toString('hex');
    this.runId = saved?.runId ?? new Date().toISOString().replace(/[:.]/g, '-');
    this.cards = new CardPool(sec.cards, saved?.cards, cfg.payment.card.parallelPerCard, cfg.payment.card.burnAfterDeclines);
    for (const o of cfg.orders) {
      const s = saved?.orders?.[o.id];
      this.orders.set(o.id, {
        id: o.id, cfg: o, state: (s?.state as OrderState) ?? 'OPEN', claimers: s?.claimers ?? [], leader: s?.leader ?? null, standby: s?.standby ?? [],
        failed: s?.failed ?? [], method: (s?.method as PayMethod) ?? o.payment, cardId: s?.cardId ?? null, attempts: s?.attempts ?? 0,
        inBagAt: s?.inBagAt, billingAt: s?.billingAt, placedAt: s?.placedAt, orderedAt: s?.orderedAt, orderNo: s?.orderNo, record: s?.record,
        store: s?.store, slotLabel: s?.slotLabel, price: s?.price,
      });
    }
    if (saved) {
      this.openedAt = saved.openedAt;
      this.openSource = saved.openSource;
      this.startedAt = saved.startedAt;
      this.adapt = saved.adapt ?? newAdapt();
      this.nextBrowserNo = saved.nextBrowserNo ?? 1;
      this.summarySent = !!saved.summarySent;
      this.holdExpired = !!saved.holdExpired;
      this.forwarders = saved.forwarders ?? {};
      for (const [id, b] of Object.entries(saved.browsers ?? {})) {
        this.browsers.set(id, {
          ...this.blankBrowser(id, String(b.token), (b.strategy as Strategy) ?? 'refresh', !!b.openJitter, b.proxyId ?? null, String(b.profileDir), String(b.extDir)),
          ...b, online: false, lastBeat: 0, stuck: false, manual: false,
        } as BrowserRt);
      }
    }
    mkdirSync(store.path('snapshots'), { recursive: true });
    mkdirSync(store.path('logs'), { recursive: true });
  }

  blankBrowser(id: string, token: string, strategy: Strategy, openJitter: boolean, proxyId: string | null, profileDir: string, extDir: string): BrowserRt {
    return {
      id, token, strategy, startStrategy: strategy, openJitter, proxyId, profileDir, extDir, status: 'STARTING', relaunches: 0,
      online: false, lastBeat: 0, state: 'STARTING', stateSince: Date.now(), reloads: 0, orderId: null, role: null, placed: false, stuck: false, manual: false, blocked: false,
    };
  }

  addBrowser(b: BrowserRt): void {
    this.browsers.set(b.id, b);
    this.persist();
  }

  get hubUrl(): string {
    return `ws://127.0.0.1:${this.port}/ext`;
  }

  // ---------- журнал / состояние ----------
  log(msg: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    const t = new Date();
    const rel = this.openedAt ? `+${((Date.now() - this.openedAt) / 1000).toFixed(1)}` : this.tMinus();
    const line = `[${t.toTimeString().slice(0, 8)}.${String(t.getMilliseconds()).padStart(3, '0')} ${rel}] [hub]${level === 'info' ? '' : ` ${level.toUpperCase()}`} ${scrub(msg, this.cfg.privacy)}`;
    this.logTail.push(line);
    if (this.logTail.length > 2000) this.logTail.splice(0, this.logTail.length - 2000);
    console.log(line);
    try { appendFileSync(this.store.path('hub.log'), `${line}\n`); } catch { /* */ }
    this.dashDirty = true;
  }

  private tMinus(): string {
    const openAt = Date.parse(this.cfg.openAt);
    return Number.isFinite(openAt) ? `T${((Date.now() - openAt) / 1000).toFixed(1)}` : '';
  }

  persist(): void {
    const browsers: Record<string, Partial<BrowserRt>> = {};
    for (const [id, b] of this.browsers) {
      const x: Partial<BrowserRt> = { ...b };
      for (const k of LIVE_KEYS) delete x[k];
      browsers[id] = x;
    }
    const orders: Record<string, Partial<OrderRt>> = {};
    for (const [id, o] of this.orders) { const { cfg: _c, ...rest } = o; orders[id] = rest; }
    const p: Persisted = {
      version: 1, runId: this.runId, machine: this.cfg.machine, startedAt: this.startedAt, dashToken: this.dashToken,
      openedAt: this.openedAt, openSource: this.openSource, browsers, orders, cards: this.cards.snapshot(), adapt: this.adapt,
      nextBrowserNo: this.nextBrowserNo, summarySent: this.summarySent, holdExpired: this.holdExpired, forwarders: this.forwarders,
    };
    this.store.save(p);
    this.dashDirty = true;
  }

  sinceOpen(t = Date.now()): number | undefined {
    return this.openedAt ? Math.round((t - this.openedAt) / 100) / 10 : undefined;
  }

  // ---------- уведомления ----------
  private recipientOf(o: OrderRt | undefined) {
    const r = o ? this.sec.recipients[o.cfg.recipient] : undefined;
    return recipientOut(r, this.cfg.notify.fullContact);
  }

  private orderView(o: OrderRt) {
    const part = o.record?.part ?? o.cfg.targets[0];
    return {
      id: o.id, number: o.orderNo, part, title: partLabel(part), store: o.store ?? o.record?.store, storeName: storeName(o.store ?? o.record?.store),
      slot: o.slotLabel ?? o.record?.slotLabel, total: o.price ?? o.record?.price,
    };
  }

  notify(event: string, data: Record<string, unknown> = {}): void {
    const e: NotifyEvent = { event, ts: new Date().toISOString(), machine: this.cfg.machine, ...data };
    this.store.event(event, data);
    this.notifier?.emit(e);
  }

  // ---------- сервер ----------
  async listen(): Promise<void> {
    const srv = http.createServer((req, res) => { void this.onHttp(req, res); });
    const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
    srv.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const origin = String(req.headers.origin ?? '');
      if (url.pathname === '/dash') {
        // дашборд — только со своей страницы и с токеном
        if (url.searchParams.get('token') !== this.dashToken || (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin))) { socket.destroy(); return; }
        wss.handleUpgrade(req, socket, head, (ws) => this.onDash(ws));
        return;
      }
      // расширения: Origin chrome-extension://…; токен проверяется в REGISTER
      if (origin && !origin.startsWith('chrome-extension://')) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => this.onExt(ws));
    });
    await new Promise<void>((resolve, reject) => { srv.once('error', reject); srv.listen(this.port, '127.0.0.1', () => resolve()); });
    this.server = srv;
    this.timers.push(setInterval(() => this.tick(), this.cfg.watchdog.checkMs));
    this.timers.push(setInterval(() => this.pushDash(), 500));
    this.log(`хаб слушает ws://127.0.0.1:${this.port}, дашборд http://127.0.0.1:${this.port}/?token=${this.dashToken}`);
  }

  close(): void {
    for (const t of this.timers) clearInterval(t);
    for (const ws of this.sockets.values()) { try { ws.close(); } catch { /* */ } }
    for (const ws of this.dashSockets) { try { ws.close(); } catch { /* */ } }
    this.server?.close();
    this.store.flush();
  }

  send(browser: string, m: Hub2S): boolean {
    const ws = this.sockets.get(browser);
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(m));
    return true;
  }

  broadcast(m: Hub2S): void {
    for (const id of this.sockets.keys()) this.send(id, m);
  }

  private onExt(ws: WebSocket): void {
    let me: string | null = null;
    ws.on('message', (data) => {
      let m: S2Hub;
      try { m = JSON.parse(String(data)); } catch { return; }
      if (m.t === 'REGISTER') { me = this.onRegister(ws, m); return; }
      if (!me || this.sockets.get(me) !== ws) return;
      try { this.onMsg(me, m); } catch (e) { this.log(`ошибка обработки ${m.t} от ${me}: ${e instanceof Error ? e.stack : e}`, 'error'); }
    });
    ws.on('close', () => { if (me && this.sockets.get(me) === ws) this.onOffline(me); });
    ws.on('error', () => {});
  }

  private onRegister(ws: WebSocket, m: Extract<S2Hub, { t: 'REGISTER' }>): string | null {
    const b = this.browsers.get(m.profile);
    if (!b || !m.bot || m.bot.token !== b.token) {
      ws.send(JSON.stringify({ t: 'REJECT', reason: 'неизвестный браузер или неверный токен' } satisfies Hub2S));
      this.log(`отклонено подключение ${m.profile}: неверный токен`, 'warn');
      ws.close();
      return null;
    }
    const prev = this.sockets.get(b.id);
    if (prev && prev !== ws) { try { prev.close(); } catch { /* */ } }
    this.sockets.set(b.id, ws);
    const wasOnline = b.online;
    b.online = true;
    b.lastBeat = Date.now();
    if (b.status === 'STARTING' || b.status === 'PROXY_DOWN') b.status = 'RUNNING';
    if (b.noConnectAt) { b.noConnectAt = undefined; b.lastError = undefined; }
    b.ext = m.bot.ext;
    if (m.bot.state && m.bot.state !== b.state) { b.state = m.bot.state; b.stateSince = Date.now(); }
    this.log(`${b.id} подключился (${m.bot.state}${m.orderId ? `, заказ ${m.orderId}` : ''})${wasOnline ? ' — переподключение' : ''}`);
    this.store.event('browser.online', { browser: b.id, state: m.bot.state, orderId: m.orderId });
    this.reconcile(b, m.orderId, m.bot);
    const rt = botRuntime(this.cfg, b.id, b.strategy, b.openJitter);
    rt.autoStart = this.mode === 'run';
    this.send(b.id, { t: 'CONFIG', cfg: toExtConfig(this.cfg, b.id, this.hubUrl, rt) });
    if (this.mode === 'prepare' && !b.prepared) { this.send(b.id, { t: 'COMMAND', cmd: 'prepare' }); return this.persistAnd(b.id); }
    if (b.orderId) this.sendAssign(b);
    this.pickWatchers();
    if (this.openedAt) this.send(b.id, { t: 'OPEN', at: this.openedAt, buyable: [], source: `hub:${this.openSource}` });
    this.persist();
    return b.id;
  }

  private persistAnd(id: string): string {
    this.persist();
    return id;
  }

  /** После перезапуска оркестратора: браузер знает свой заказ лучше, чем потерянное состояние (§3.6). */
  private reconcile(b: BrowserRt, extOrder: string | null, r: NonNullable<Extract<S2Hub, { t: 'REGISTER' }>['bot']>): void {
    if (r.openedAt && !this.openedAt) { this.openedAt = r.openedAt; this.openSource = `${b.id}/восстановлено`; }
    if (!extOrder) {
      if (b.orderId && !b.placed) {
        const o = this.orders.get(b.orderId);
        // браузер потерял заказ (перезапуск) — снять его с заказа
        if (o) { this.dropFromOrder(o, b.id, false); this.reviveOrder(o, 'браузер потерял заказ'); }
        b.orderId = null;
        b.role = null;
      }
      return;
    }
    const o = this.orders.get(extOrder);
    if (!o) return;
    b.orderId = o.id;
    if (!o.claimers.includes(b.id)) o.claimers.push(b.id);
    if (r.leader && (!o.leader || o.leader === b.id)) { o.leader = b.id; b.role = 'leader'; if (o.state === 'OPEN' || o.state === 'CLAIMED') o.state = 'IN_BAG'; }
    else if (!b.role) b.role = 'claimer';
    if (r.placed) { b.placed = true; if (!['ORDERED', 'NEED_HUMAN'].includes(o.state)) o.state = 'PLACED'; }
    if (r.orderNo && o.state !== 'ORDERED') {
      // заказ оформился, пока оркестратор лежал (§3.5) — записать и уведомить
      setTimeout(() => this.onOrdered(b, o.id, r.orderNo!), 0);
    }
    if (r.payMethod) o.method = r.payMethod === 'manual' ? 'card' : 'applepay';
  }

  private onOffline(id: string): void {
    const b = this.browsers.get(id);
    this.sockets.delete(id);
    if (!b) return;
    b.online = false;
    this.log(`${id} отключился`, 'warn');
    this.store.event('browser.offline', { browser: id });
    this.pickWatchers();
    this.persist();
  }

  // ---------- сообщения расширений ----------
  private onMsg(id: string, m: S2Hub): void {
    const b = this.browsers.get(id)!;
    b.lastBeat = Date.now();
    switch (m.t) {
      case 'PING': this.send(id, { t: 'PONG' }); break;
      case 'LOG': this.onLog(b, m.line); break;
      case 'STATUS': break; // старый протокол (вкладки профиля) — в режиме бота пульс идёт через STATE
      case 'STATE': this.onState(b, m); break;
      case 'OPEN': this.onOpen(b, m.source, m.buyable); break;
      case 'ADMITTED': this.onAdmitted(b, m.at); break;
      case 'WIN_REQ': this.onWinReq(b, m.orderId); break;
      case 'FAILED': this.onFailed(b, m.orderId, m.reason); break;
      case 'RELEASED': this.onReleased(b, m.orderId, m.reason); break;
      case 'PAY_READY': this.onPayReady(b, m); break;
      case 'PAY_DONE': break;
      case 'NEXT': this.nextAttention('кнопка «Следующий»'); break;
      case 'ORDERED': this.onOrdered(b, m.orderId, m.orderNo, m.record); break;
      case 'PLACE_REQ': this.onPlaceReq(b, m.orderId); break;
      case 'PLACED': this.onPlaced(b, m.orderId, m.at); break;
      case 'PAY_WAIT': this.onPayWait(b, m.orderId, m.kind, !!m.input, m.detail); break;
      case 'CARD_DECLINED': this.onDeclined(b, m.orderId, m.text); break;
      case 'CARD_SWAP_ACK': this.log(`${id}: смена карты ${m.ok ? 'выполнена' : 'не выполнена'}${m.detail ? ` (${m.detail})` : ''}`, m.ok ? 'info' : 'warn'); break;
      case 'CARD_REQ': this.onCardReq(b, m.orderId); break;
      case 'NEED_HUMAN': this.onNeedHuman(b, m.reason, m.text, m.step); break;
      case 'HUMAN_DONE': this.onHumanDone(b); break;
      case 'HUMAN': this.onHuman(b, m.action); break;
      case 'CLICK_REQ': void this.onClickReq(b, m.how, m.target); break;
      case 'SNAPSHOT': this.onSnapshot(b, m); break;
      case 'BLOCKED': void this.onBlocked(b, m.status, m.text); break;
      case 'PREPARED': b.prepared = { ok: m.ok, detail: m.detail, at: Date.now() }; this.log(`${id}: Prepare ${m.ok ? '✓' : '✗'} — ${m.detail}`); this.store.event('prepared', { browser: id, ok: m.ok, detail: m.detail }); break;
      case 'CLEANED': this.log(`${id}: корзина очищена (${m.count})`); break;
      default: break;
    }
  }

  private onLog(b: BrowserRt, line: string): void {
    try { appendFileSync(this.store.path('logs', `${b.id}.log`), `${line}\n`); } catch { /* */ }
  }

  private onState(b: BrowserRt, m: Extract<S2Hub, { t: 'STATE' }>): void {
    const changed = m.state !== b.state;
    const prevPage = b.page;
    if (changed) { b.state = m.state; b.stateSince = m.since || Date.now(); }
    Object.assign(b, { mode: m.mode, detail: m.detail, step: m.step, path: m.path, reloads: m.reloads ?? b.reloads, manual: !!m.manual });
    if (m.page) b.page = m.page;
    if (m.error) b.lastError = m.error;
    if (m.perf) this.store.event('step', { browser: b.id, ...m.perf, sinceOpen: this.sinceOpen(), orderId: b.orderId });
    if (changed) {
      this.store.event('state', { browser: b.id, state: m.state, page: m.page, step: m.step, orderId: b.orderId, sinceOpen: this.sinceOpen() });
      if (b.stuck) { b.stuck = false; this.log(`${b.id}: вышел из зависания (${m.state})`); }
      this.resolveByState(b);
    }
    if (m.page && m.page !== prevPage) {
      this.store.event('page', { browser: b.id, cls: m.page, strategy: b.strategy, proxy: b.proxyId, reloads: b.reloads, sinceOpen: this.sinceOpen() });
      if (m.page === 'closed' && !this.storeClosedNotified && !this.openedAt) {
        this.storeClosedNotified = true;
        this.notify('store.closed', { browser: b.id, reason: b.detail ?? 'заглушка' });
      }
    }
    this.dashDirty = true;
  }

  private resolveByState(b: BrowserRt): void {
    let changed = false;
    for (const it of [...this.attn.items].filter((x) => x.browser === b.id)) {
      const done = it.reason === 'applepay_qr'
        ? ['ORDERED', 'PAY_TIMEOUT', 'NEED_HUMAN', 'STOPPED', 'MANUAL'].includes(b.state)
        : it.reason === '3ds_input' ? b.state !== 'WAIT_3DS' : b.state !== it.state;
      if (done) { if (this.attn.resolve(b.id, it.reason)) changed = true; this.log(`${b.id}: «${it.reason}» разрешилось (${b.state})`); }
    }
    if (changed || !this.attn.active) this.processAttention();
  }

  private onOpen(b: BrowserRt, source: string, buyable: string[]): void {
    if (this.openedAt) return;
    this.openedAt = Date.now();
    this.openSource = `${b.id}/${source}`;
    this.log(`OPEN от ${b.id} (${source}), buyable: ${buyable.join(',') || '—'}`);
    this.broadcast({ t: 'OPEN', at: this.openedAt, buyable, source });
    this.notify('store.opened', { browser: b.id, reason: source });
    this.persist();
  }

  // ---------- пул и назначение (§6) ----------
  private alive = (id: string) => { const x = this.browsers.get(id); return !!x && x.status !== 'DEAD' && x.status !== 'RETIRED' && x.status !== 'STOPPED'; };

  private onAdmitted(b: BrowserRt, at: number): void {
    if (!b.admittedAt) {
      b.admittedAt = at;
      b.admittedStrategy = b.strategy;
      const px = b.proxyLabel ?? (b.proxyId ? b.proxyId : 'dir');
      this.log(`${b.id} пущен (${b.strategy}, ${px})${this.openedAt ? ` +${((at - this.openedAt) / 1000).toFixed(1)} с от OPEN` : ''}`);
      this.notify('browser.admitted', { browser: b.id, strategy: b.strategy, proxy: px, exitIp: b.exitIp, sinceOpenSec: this.sinceOpen(at) });
    }
    if (b.orderId) {
      const o = this.orders.get(b.orderId);
      if (o && ['OPEN', 'CLAIMED', 'IN_BAG'].includes(o.state)) { this.sendAssign(b); return; }
      b.orderId = null;
    }
    this.assignTo(b);
  }

  private assignTo(b: BrowserRt): void {
    const views = [...this.orders.values()].map((o) => ({ id: o.id, priority: o.cfg.priority, state: o.state, claimers: o.claimers, failed: o.failed }));
    const pick = pickOrder(views, this.cfg.fleet.claimersPerOrder, b.id, this.alive);
    if (!pick) {
      b.role = 'spare';
      this.send(b.id, { t: 'SPARE' });
      this.log(`${b.id}: заказов не хватило — SPARE`);
      this.store.event('spare', { browser: b.id });
      this.persist();
      return;
    }
    const o = this.orders.get(pick.id)!;
    o.claimers = o.claimers.filter((c) => this.alive(c) && c !== b.id);
    o.claimers.push(b.id);
    if (o.state === 'OPEN') o.state = 'CLAIMED';
    b.orderId = o.id;
    b.role = o.leader ? 'claimer' : 'claimer';
    b.placed = false;
    this.sendAssign(b);
    this.log(`ASSIGN ${o.id} → ${b.id} (претендентов ${o.claimers.length}/${this.cfg.fleet.claimersPerOrder})`);
    this.store.event('assign', { browser: b.id, orderId: o.id, claimers: o.claimers.length, sinceOpen: this.sinceOpen() });
    this.persist();
  }

  private sendAssign(b: BrowserRt): void {
    const o = b.orderId ? this.orders.get(b.orderId) : undefined;
    if (!o) return;
    const rec = this.sec.recipients[o.cfg.recipient];
    let card = null;
    if (o.method === 'card') {
      const c = o.cardId ? this.cards.get(o.cardId) : this.cards.assign(o.id);
      if (c && c.status !== 'BURNED') {
        o.cardId = c.id;
        card = this.sec.cards.find((x) => x.id === c.id) ?? null;
      } else {
        // карт нет — Apple Pay (§9.3 п. 5)
        o.method = 'applepay';
        o.cardId = null;
        this.log(`заказ ${o.id}: свободной карты нет — Apple Pay`, 'warn');
      }
    }
    this.send(b.id, { t: 'ASSIGN', order: toExtOrder(this.cfg, o.cfg, rec, card, o.method, b.id) });
  }

  /** Снять браузер с заказа (освободить место претендента). */
  private dropFromOrder(o: OrderRt, id: string, failed: boolean): void {
    o.claimers = o.claimers.filter((x) => x !== id);
    o.standby = o.standby.filter((x) => x !== id);
    if (failed && !o.failed.includes(id)) o.failed.push(id);
    if (o.leader === id) o.leader = null;
  }

  /** Заказ потерял лидера до Place Order: запас → TAKEOVER, иначе снова свободен и уходит SPARE-браузеру (§6.6). */
  private reviveOrder(o: OrderRt, reason: string): void {
    if (['PLACED', 'ORDERED', 'NEED_HUMAN'].includes(o.state)) return;
    while (o.standby.length) {
      const cand = o.standby.shift()!;
      const cb = this.browsers.get(cand);
      if (!cb?.online || !this.alive(cand) || o.failed.includes(cand)) continue;
      o.leader = cand;
      cb.role = 'leader';
      o.state = 'IN_BAG';
      this.log(`заказ ${o.id}: TAKEOVER → ${cand} (${reason})`);
      this.send(cand, { t: 'WIN', orderId: o.id, profile: cand, takeover: true });
      this.store.event('takeover', { orderId: o.id, browser: cand, reason });
      this.persist();
      return;
    }
    o.state = o.claimers.some(this.alive) ? 'CLAIMED' : 'OPEN';
    o.billingAt = undefined;
    this.attn.items = this.attn.items.filter((x) => x.orderId !== o.id || x.reason !== 'applepay_qr');
    this.log(`заказ ${o.id}: снова свободен (${reason})`);
    const spares = [...this.browsers.values()].filter((x) => x.online && x.role === 'spare' && !x.orderId && this.alive(x.id)).sort((a, b2) => (a.admittedAt ?? 0) - (b2.admittedAt ?? 0));
    for (const s of spares) {
      if (o.claimers.filter(this.alive).length >= this.cfg.fleet.claimersPerOrder) break;
      this.assignTo(s);
    }
    this.persist();
  }

  private onWinReq(b: BrowserRt, orderId: string): void {
    const o = this.orders.get(orderId);
    if (!o) return;
    if (!o.leader || o.leader === b.id) {
      o.leader = b.id;
      b.role = 'leader';
      o.failed = o.failed.filter((x) => x !== b.id);
      if (!['PAY_READY', 'PLACED', 'ORDERED', 'NEED_HUMAN'].includes(o.state)) o.state = 'IN_BAG';
      const first = !o.inBagAt;
      o.inBagAt ??= Date.now();
      this.log(`заказ ${o.id}: WIN → ${b.id} (лидер)`);
      this.send(b.id, { t: 'WIN', orderId, profile: b.id });
      if (first) this.notify('order.in_bag', { browser: b.id, orderId, order: this.orderView(o), sinceOpenSec: this.sinceOpen() });
    } else {
      if (!o.standby.includes(b.id)) o.standby.push(b.id);
      b.role = 'standby';
      this.log(`заказ ${o.id}: LOSE → ${b.id} (запас, лидер ${o.leader})`);
      this.send(b.id, { t: 'LOSE', orderId });
      if (o.billingAt) this.send(b.id, { t: 'CLEAN', orderId });
    }
    this.persist();
  }

  private onFailed(b: BrowserRt, orderId: string, reason: string): void {
    const o = this.orders.get(orderId);
    if (!o) return;
    if (b.placed || ['PLACED', 'ORDERED'].includes(o.state)) { this.log(`заказ ${o.id}: ${b.id} упал после Place Order — заказ не передаю`, 'warn'); return; }
    this.dropFromOrder(o, b.id, true);
    b.orderId = null;
    b.role = null;
    this.reviveOrder(o, `${b.id}: ${reason}`);
  }

  private onReleased(b: BrowserRt, orderId: string, reason: string): void {
    const o = this.orders.get(orderId);
    if (o) this.dropFromOrder(o, b.id, false);
    if (b.orderId === orderId) { b.orderId = null; b.role = null; }
    this.log(`${b.id} вернулся в пул (${reason})`);
    this.store.event('released', { browser: b.id, orderId, reason });
    this.persist();
  }

  // ---------- оплата (§9) ----------
  private onPayReady(b: BrowserRt, m: Extract<S2Hub, { t: 'PAY_READY' }>): void {
    const o = this.orders.get(m.orderId);
    if (!o) return;
    if (o.leader !== b.id) { this.log(`PAY_READY от ${b.id}, но лидер заказа ${o.id} — ${o.leader}; игнорирую`, 'warn'); return; }
    const method: PayMethod = m.method === 'applepay' ? 'applepay' : m.method === 'manual' ? 'card' : o.method;
    if (method !== o.method) {
      if (method === 'applepay' && o.cardId) { this.cards.release(o.id); o.cardId = null; }
      o.method = method;
    }
    if (!['PLACED', 'ORDERED', 'NEED_HUMAN'].includes(o.state)) o.state = 'PAY_READY';
    o.billingAt ??= Date.now();
    o.store = m.store;
    o.slotLabel = m.slotLabel;
    if (m.record) { o.record = m.record; o.price = m.record.price ?? o.price; }
    this.log(`заказ ${o.id}: Billing у ${b.id} · ${storeName(m.store)} · ${m.slotLabel} · ${method === 'card' ? `карта ****${this.cards.get(o.cardId)?.last4 ?? '?'}` : 'Apple Pay'}${this.openedAt ? ` (+${this.sinceOpen()} с от OPEN)` : ''}`);
    this.store.event('billing', { browser: b.id, orderId: o.id, method, sinceOpen: this.sinceOpen() });
    for (const sb of o.standby) this.send(sb, { t: 'CLEAN', orderId: o.id });
    if (method === 'card' || this.cfg.payment.stopBeforePay) {
      // карта: Review и Place Order бот жмёт сам, человек — только в приложении банка; разные карты — параллельно (§20.10)
      this.send(b.id, { t: 'PAY_TURN', orderId: o.id, profile: b.id });
    } else {
      // Apple Pay: QR живёт недолго — по одному окну через очередь внимания (§9.2 п. 2)
      this.attn.add({ browser: b.id, reason: 'applepay_qr', text: 'очередь Apple Pay', orderId: o.id, state: b.state });
      this.processAttention();
    }
    this.persist();
  }

  private onPlaceReq(b: BrowserRt, orderId: string): void {
    const o = this.orders.get(orderId);
    if (!o || o.leader !== b.id) { this.log(`PLACE_REQ от ${b.id}: он не лидер заказа ${orderId}`, 'warn'); return; }
    if (o.method !== 'card' || !o.cardId) {
      // карта ушла (сгорела, Apple Pay) — напомнить браузеру способ оплаты
      this.log(`PLACE_REQ от ${b.id}: у заказа ${orderId} нет карты — Apple Pay`, 'warn');
      this.send(b.id, { t: 'SWITCH_PAY', orderId: o.id, method: 'applepay' });
      return;
    }
    const r = this.cards.requestPlace(o.cardId, b.id, o.id);
    if (r === 'granted') {
      this.log(`PLACE_TURN → ${b.id} (заказ ${o.id}, карта ****${this.cards.get(o.cardId)?.last4})`);
      this.send(b.id, { t: 'PLACE_TURN', orderId: o.id });
    } else if (r === 'queued') {
      this.log(`${b.id}: Place Order ждёт — по карте ****${this.cards.get(o.cardId)?.last4} уже ждут подтверждения банка`);
    } else this.cardGone(o, 'карта сгорела до Place Order');
    this.persist();
  }

  private onPlaced(b: BrowserRt, orderId: string, at: number): void {
    const o = this.orders.get(orderId);
    if (!o) return;
    b.placed = true;
    o.placedAt = at;
    if (o.state !== 'ORDERED') o.state = 'PLACED';
    if (o.cardId) this.cards.placed(o.cardId, b.id, o.id);
    this.log(`заказ ${o.id}: Place Order нажат (${b.id})`);
    this.store.event('placed', { browser: b.id, orderId, cardLast4: this.cards.get(o.cardId)?.last4, sinceOpen: this.sinceOpen(at) });
    this.persist();
  }

  private onPayWait(b: BrowserRt, orderId: string, kind: string, input: boolean, detail?: string): void {
    const o = this.orders.get(orderId);
    b.payWait = kind;
    if (kind === '3ds') {
      const payload = { browser: b.id, orderId, order: o ? this.orderView(o) : undefined, recipient: this.recipientOf(o), cardLast4: this.cards.get(o?.cardId)?.last4, input, detail };
      if (o && o.notified3ds !== o.attempts) { o.notified3ds = o.attempts; this.notify('pay.3ds', payload); }
      if (input) { this.attn.add({ browser: b.id, reason: '3ds_input', text: '3-D Secure: банк просит ввод на странице', orderId, state: 'WAIT_3DS' }); this.processAttention(); }
    } else {
      this.notify('applepay.qr', { browser: b.id, orderId, order: o ? this.orderView(o) : undefined, recipient: this.recipientOf(o) });
      this.fleet?.activate(b.id);
      beep('attention');
      if (this.cfg.payment.applePay.sendQrScreenshot && b.cdpPort) {
        void withPage(b.cdpPort, (cdp, sid) => cdp.screenshot(sid)).then((png) => this.notifier?.photo(png, `QR Apple Pay · заказ ${orderId} · ${b.id}`)).catch((e) => this.log(`скриншот QR: ${e}`, 'warn'));
      }
    }
    this.persist();
  }

  private onOrdered(b: BrowserRt, orderId: string, orderNo: string, record?: OrderRecord): void {
    const o = this.orders.get(orderId);
    if (!o) return;
    const first = o.state !== 'ORDERED' || o.orderNo !== orderNo;
    o.state = 'ORDERED';
    o.orderNo = orderNo;
    o.orderedAt ??= Date.now();
    if (record) { o.record = record; o.price = record.price ?? o.price; }
    b.payWait = undefined;
    if (o.method === 'card' && o.cardId) {
      const next = this.cards.markPaid(o.cardId, o.id);
      if (next) this.grant(next.browser, next.orderId);
    }
    this.attn.resolve(b.id);
    this.processAttention();
    if (first) {
      const card = o.method === 'card' ? this.cards.get(o.cardId)?.last4 : undefined;
      this.log(`✅ заказ ${o.id}: ${orderNo} (${b.id})`);
      beep('done');
      const t = (x?: number) => (x && this.openedAt ? Math.round((x - this.openedAt) / 100) / 10 : undefined);
      this.notify('order.placed', {
        browser: b.id, order: this.orderView(o), recipient: this.recipientOf(o),
        payment: { method: o.method, ...(card ? { cardLast4: card } : {}) },
        proxy: b.proxyLabel ?? (b.proxyId ?? 'dir'), strategy: b.startStrategy,
        timings: { openToAdmittedSec: t(b.admittedAt), openToBagSec: t(o.inBagAt), openToOrderSec: t(o.orderedAt) },
      });
    }
    this.persist();
  }

  private grant(browser: string, orderId: string): void {
    this.log(`PLACE_TURN → ${browser} (заказ ${orderId}) — карта освободилась`);
    this.send(browser, { t: 'PLACE_TURN', orderId });
  }

  /** Явный отказ карты (§9.3): сжечь, этот браузер — на Apple Pay, остальным с этой картой — замена. */
  private onDeclined(b: BrowserRt, orderId: string, text: string): void {
    const o = this.orders.get(orderId);
    if (!o) return;
    const cardId = o.cardId;
    const card = this.cards.get(cardId);
    const res = cardId ? this.cards.decline(cardId, o.id) : { burned: false, next: null };
    o.attempts++;
    this.log(`❌ заказ ${o.id}: отказ карты ****${card?.last4 ?? '?'} у ${b.id}: ${text}${res.burned ? ' — карта сгорела' : ''}`, 'warn');
    this.notify('card.declined', { browser: b.id, orderId, cardId, cardLast4: card?.last4, text: text.slice(0, 300), recipient: this.recipientOf(o), order: this.orderView(o) });
    // этот браузер — Apple Pay: вторая и последняя автоматическая попытка
    this.cards.release(o.id);
    o.cardId = null;
    o.method = 'applepay';
    o.state = 'PAY_READY';
    b.placed = false;
    if (o.attempts >= 2) {
      this.onNeedHuman(b, 'payment', `вторая попытка оплаты тоже не прошла: ${text}`, 'CARD_DECLINED');
    } else this.send(b.id, { t: 'SWITCH_PAY', orderId: o.id, method: 'applepay' });
    if (res.burned && cardId) this.burnCascade(cardId, o.id);
    else if (res.next) this.grant(res.next.browser, res.next.orderId);
    this.persist();
  }

  /** Сгоревшая карта: всем остальным заказам с ней — запасная, а нет запасных — Apple Pay (§9.3 п. 3, 5). */
  private burnCascade(cardId: string, except: string): void {
    const waiting = this.cards.dropQueue(cardId);
    let exhausted = false;
    for (const o of this.orders.values()) {
      if (o.id === except || o.cardId !== cardId || ['PLACED', 'ORDERED'].includes(o.state)) continue;
      if (!this.cardGone(o, 'карта сгорела')) exhausted = true;
    }
    for (const w of waiting) this.log(`${w.browser}: запрос Place Order по сгоревшей карте снят`);
    if (exhausted) this.notify('cards.exhausted', { cardId, cardLast4: this.cards.get(cardId)?.last4 });
  }

  /** Заказ потерял карту: замена из reserve (CARD_SWAP) или Apple Pay (SWITCH_PAY). false — запасных нет. */
  private cardGone(o: OrderRt, why: string): boolean {
    const from = this.cards.get(o.cardId)?.last4;
    const rep = this.cards.replacement(o.id);
    const browsers = [...this.browsers.values()].filter((x) => x.orderId === o.id);
    if (rep) {
      o.cardId = rep.id;
      const def = this.sec.cards.find((x) => x.id === rep.id)!;
      for (const x of browsers) this.send(x.id, { t: 'CARD_SWAP', orderId: o.id, cardId: rep.id, card: { number: def.number, expiry: def.expiry, cvv: def.cvv, name: def.name }, billing: { ...def.billing } });
      this.log(`заказ ${o.id}: ${why} → карта ****${rep.last4}`);
      this.notify('card.swapped', { orderId: o.id, from, to: rep.last4, browser: o.leader ?? undefined });
      return true;
    }
    o.cardId = null;
    o.method = 'applepay';
    for (const x of browsers) this.send(x.id, { t: 'SWITCH_PAY', orderId: o.id, method: 'applepay' });
    this.log(`заказ ${o.id}: ${why}, запасных карт нет → Apple Pay`, 'warn');
    return false;
  }

  private onCardReq(b: BrowserRt, orderId: string): void {
    const o = this.orders.get(orderId);
    if (!o || o.leader !== b.id) return;
    const c = this.cards.anyFree(o.id);
    if (!c) { this.log(`${b.id}: Apple Pay недоступен, свободной карты нет — человек`, 'warn'); return; }
    const def = this.sec.cards.find((x) => x.id === c.id)!;
    o.cardId = c.id;
    o.method = 'card';
    this.send(b.id, { t: 'CARD_SWAP', orderId: o.id, cardId: c.id, card: { number: def.number, expiry: def.expiry, cvv: def.cvv, name: def.name }, billing: { ...def.billing } });
    this.log(`заказ ${o.id}: Apple Pay недоступен → карта ****${c.last4}`);
    this.persist();
  }

  // ---------- человек (§10) ----------
  onNeedHuman(b: BrowserRt, reason: HumanReason, text: string, step: string): void {
    const o = b.orderId ? this.orders.get(b.orderId) : undefined;
    if (reason === 'payment' && o && ['PLACED', 'PAY_READY'].includes(o.state) && b.placed) {
      o.state = 'NEED_HUMAN';
      if (o.cardId) { const next = this.cards.settle(o.cardId, o.id); if (next) this.grant(next.browser, next.orderId); }
    }
    if (reason === 'payment' || reason === 'stuck') this.attn.resolve(b.id, 'applepay_qr');
    const isNew = !this.attn.has(b.id, reason);
    // состояние, в котором браузер попросил человека: его смена = человек разобрался
    this.attn.add({ browser: b.id, reason, text, orderId: b.orderId, state: step || b.state });
    if (isNew) {
      this.log(`🙋 ${b.id}: нужен человек (${reason}) — ${text}`, 'warn');
      this.notify('human.needed', { browser: b.id, reason, text, step, orderId: b.orderId, recipient: this.recipientOf(o) });
      if (b.cdpPort) void this.screenshot(b, `human-${reason}`);
    }
    this.processAttention();
    this.persist();
  }

  private onHumanDone(b: BrowserRt): void {
    let changed = false;
    for (const it of [...this.attn.items].filter((x) => x.browser === b.id && x.reason !== 'applepay_qr' && x.reason !== '3ds_input')) if (this.attn.resolve(b.id, it.reason)) changed = true;
    b.stuck = false;
    if (changed) this.log(`${b.id}: человек разобрался`);
    this.processAttention();
  }

  private onHuman(b: BrowserRt, action: 'resume' | 'manual' | 'stop'): void {
    this.log(`${b.id}: кнопка «${action === 'resume' ? 'Продолжить автоматику' : action === 'manual' ? 'Дальше я сам' : 'Стоп'}»`);
    this.store.event('human', { browser: b.id, action });
    if (action === 'stop') this.stopBrowser(b, 'Стоп на плашке');
    else this.onHumanDone(b);
  }

  /** «Стоп»: браузер выходит из гонки; заказ возвращается в пул, если Place Order не нажат (§10). */
  stopBrowser(b: BrowserRt, reason: string): void {
    b.status = 'STOPPED';
    this.attn.resolve(b.id);
    for (const g of this.cards.settleBrowser(b.id)) this.grant(g.browser, g.orderId);
    const o = b.orderId ? this.orders.get(b.orderId) : undefined;
    if (o) {
      if (b.placed || ['PLACED', 'ORDERED'].includes(o.state)) this.log(`${b.id} остановлен, но Place Order по заказу ${o.id} уже нажат — заказ не передаю`, 'warn');
      else { this.dropFromOrder(o, b.id, true); b.orderId = null; b.role = null; this.reviveOrder(o, reason); }
    }
    this.send(b.id, { t: 'COMMAND', cmd: 'stop' });
    this.processAttention();
    this.persist();
  }

  processAttention(): void {
    const it = this.attn.next();
    if (!it) return;
    const b = this.browsers.get(it.browser);
    // без связи окно всё равно выводим (ОС): прокси упал / браузер с заказом заблокирован — человек нужнее всего
    const keepOffline = ['proxy_down', 'dead', 'blocked'].includes(it.reason);
    if (!b || !this.alive(b.id) && it.reason !== 'dead' || (!b.online && !keepOffline)) {
      this.attn.resolve(it.browser, it.reason);
      this.processAttention();
      return;
    }
    this.activate(it, b);
  }

  private activate(it: AttnItem, b: BrowserRt): void {
    this.log(`👉 вперёд: ${b.id} (${it.reason}: ${it.text})`);
    this.store.event('attention', { browser: b.id, reason: it.reason, text: it.text, sinceState: Date.now() - b.stateSince });
    if (it.reason === 'applepay_qr' && it.orderId) this.send(b.id, { t: 'PAY_TURN', orderId: it.orderId, profile: b.id });
    this.send(b.id, { t: 'COMMAND', cmd: 'focus' });
    this.fleet?.activate(b.id);
    if (it.reason !== 'applepay_qr') beep('attention');
    this.dashDirty = true;
  }

  nextAttention(why: string): void {
    const cur = this.attn.active;
    const it = this.attn.skip();
    this.log(`«Дальше» (${why}): ${cur?.browser ?? '—'} → ${it?.browser ?? '—'}`);
    if (it) { const b = this.browsers.get(it.browser); if (b) this.activate(it, b); }
  }

  // ---------- клик Apple Pay через CDP / macOS (§9.2) ----------
  private async onClickReq(b: BrowserRt, how: 'cdp' | 'os', target: ClickTarget): Promise<void> {
    try {
      if (how === 'cdp') {
        if (!b.cdpPort) throw new Error('порт отладки выключен (fleet.cdp)');
        await withPage(b.cdpPort, async (cdp, sid) => {
          await cdp.bringToFront(sid).catch(() => {});
          await cdp.click(sid, target.rect.x + target.rect.w / 2, target.rect.y + target.rect.h / 2);
        }, (u) => u.startsWith(this.cfg.baseUrl) || /apple\.com/.test(u));
        this.log(`${b.id}: клик Apple Pay через CDP`);
        this.send(b.id, { t: 'CLICK_DONE', ok: true, how });
      } else {
        this.fleet?.activate(b.id);
        await new Promise((r) => setTimeout(r, 400));
        const r = await osClick(target.screen.x, target.screen.y);
        this.log(`${b.id}: клик Apple Pay средствами macOS: ${r.ok ? 'ok' : r.error}`, r.ok ? 'info' : 'warn');
        this.send(b.id, { t: 'CLICK_DONE', ok: r.ok, how, error: r.error });
      }
    } catch (e) {
      this.log(`${b.id}: клик ${how} не удался: ${e instanceof Error ? e.message : e}`, 'warn');
      this.send(b.id, { t: 'CLICK_DONE', ok: false, how, error: e instanceof Error ? e.message : String(e) });
    }
  }

  async screenshot(b: BrowserRt, reason: string): Promise<string | null> {
    if (!b.cdpPort) return null;
    try {
      const png = await withPage(b.cdpPort, (cdp, sid) => cdp.screenshot(sid));
      const file = this.store.path('snapshots', `${new Date().toISOString().replace(/[:.]/g, '-')}-${b.id}-${reason}.png`);
      writeFileSync(file, png);
      this.store.event('screenshot', { browser: b.id, reason, file });
      return file;
    } catch (e) {
      this.log(`${b.id}: скриншот не снят: ${e instanceof Error ? e.message : e}`, 'warn');
      return null;
    }
  }

  // ---------- снимки заглушки (§7) ----------
  private onSnapshot(b: BrowserRt, m: Extract<S2Hub, { t: 'SNAPSHOT' }>): void {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = join(this.store.path('snapshots'), `${stamp}-${b.id}-${m.reason.replace(/[^\w.+-]/g, '_')}-${m.cls}`);
    const html = scrubHtml(m.html);
    writeFileSync(`${base}.html`, html, { mode: 0o600 });
    const meta = { browser: b.id, reason: m.reason, cls: m.cls, url: m.url, title: m.title, status: m.status, metaRefresh: m.metaRefresh, headers: m.headers, strategy: b.strategy, proxy: b.proxyId, sinceOpen: this.sinceOpen(), text: htmlText(html).slice(0, 600) };
    writeFileSync(`${base}.json`, JSON.stringify(meta, null, 1), { mode: 0o600 });
    this.store.event('snapshot', { ...meta, text: meta.text.slice(0, 200), file: `${base}.html` });
  }

  // ---------- блокировки (§8) ----------
  private async onBlocked(b: BrowserRt, status: number, text: string): Promise<void> {
    if (b.blocked) return;
    b.blocked = true;
    const px = b.proxyLabel ?? b.proxyId ?? 'dir';
    const o = b.orderId ? this.orders.get(b.orderId) : undefined;
    if (o || b.role === 'leader' || b.role === 'standby') {
      this.notify('browser.blocked', { browser: b.id, proxy: px, exitIp: b.exitIp, status, text: text.slice(0, 200), orderId: b.orderId });
      this.onNeedHuman(b, 'blocked', `доступ закрыт (${status}) на ${px} — браузер с заказом не перезапускаю`, b.state);
      return;
    }
    let relaunched: string | null = null;
    if (this.cfg.proxies.relaunchOnBlock && this.fleet) {
      const spare = this.fleet.spareProxy();
      if (spare) {
        relaunched = await this.fleet.relaunch(b.id, `блокировка на ${px}`, { newProfile: true, proxyId: spare });
      } else this.log(`${b.id}: заблокирован на ${px}, запасных прокси нет — остаётся и рефрешит раз в 30 с`, 'warn');
    }
    this.notify('browser.blocked', { browser: b.id, proxy: px, exitIp: b.exitIp, status, text: text.slice(0, 200), relaunched: relaunched ?? undefined });
    this.persist();
  }

  /** Процесс браузера умер (лаунчер, §4). */
  onDead(id: string, code: number | null): void {
    const b = this.browsers.get(id);
    if (!b || b.status === 'RETIRED' || b.status === 'STOPPED') return;
    b.status = 'DEAD';
    b.online = false;
    this.sockets.delete(id);
    for (const g of this.cards.settleBrowser(id)) this.grant(g.browser, g.orderId);
    const o = b.orderId ? this.orders.get(b.orderId) : undefined;
    const placed = b.placed || (!!o && o.leader === id && ['PLACED', 'ORDERED'].includes(o.state));
    this.log(`💀 ${id} упал (код ${code ?? '?'})${o ? `, заказ ${o.id}` : ''}${placed ? ' — Place Order нажат, зову человека' : ''}`, 'warn');
    this.notify('browser.dead', { browser: id, orderId: b.orderId, placed, relaunch: !placed });
    if (placed && o) {
      if (o.state !== 'ORDERED') o.state = 'NEED_HUMAN';
      this.attn.add({ browser: id, reason: 'dead', text: 'браузер упал после Place Order — проверь почту и номер заказа', orderId: o.id, state: 'DEAD' });
      this.persist();
      return;
    }
    if (o) { this.dropFromOrder(o, id, true); b.orderId = null; b.role = null; this.reviveOrder(o, `${id} упал`); }
    this.attn.resolve(id);
    this.processAttention();
    this.pickWatchers();
    this.persist();
    void this.fleet?.relaunch(id, 'упал', { newProfile: false });
  }

  /** Прокси упал (форвардер, §8). */
  onProxyDown(proxyId: string, error: string): void {
    const users = [...this.browsers.values()].filter((b) => b.proxyId === proxyId && this.alive(b.id));
    this.log(`📡 прокси ${proxyId} не отвечает: ${error}`, 'warn');
    this.notify('proxy.down', { proxy: proxyId, error, browsers: users.map((b) => b.id) });
    for (const b of users) {
      b.status = 'PROXY_DOWN';
      if (b.orderId || b.role === 'standby') { this.onNeedHuman(b, 'proxy_down', `прокси ${proxyId} не отвечает — IP с заказом не меняю`, b.state); continue; }
      const spare = this.fleet?.spareProxy();
      if (spare) void this.fleet!.relaunch(b.id, `прокси ${proxyId} упал`, { newProfile: true, proxyId: spare });
    }
    this.persist();
  }

  onProxyUp(proxyId: string): void {
    for (const b of this.browsers.values()) if (b.proxyId === proxyId && b.status === 'PROXY_DOWN') b.status = 'RUNNING';
    this.log(`📡 прокси ${proxyId} снова отвечает`);
    this.store.event('proxy.up', { proxy: proxyId });
  }

  // ---------- наблюдатели JSON (§7: два, на разных IP) ----------
  pickWatchers(): void {
    const online = [...this.browsers.values()].filter((b) => b.online && this.alive(b.id)).sort((a, b) => (a.strategy === 'refresh' ? 0 : 1) - (b.strategy === 'refresh' ? 0 : 1) || a.id.localeCompare(b.id));
    const keep = this.watchers.filter((w) => online.some((b) => b.id === w));
    const out: string[] = [];
    for (const w of keep) if (out.length < 2 && !out.some((x) => this.browsers.get(x)!.proxyId === this.browsers.get(w)!.proxyId)) out.push(w);
    for (const b of online) {
      if (out.length >= 2) break;
      if (out.includes(b.id) || out.some((x) => this.browsers.get(x)!.proxyId === b.proxyId)) continue;
      out.push(b.id);
    }
    if (out.length < 2) for (const b of online) { if (out.length >= 2) break; if (!out.includes(b.id)) out.push(b.id); }
    const targets = [...new Set(this.cfg.orders.flatMap((o) => o.targets))];
    if (out.join() !== this.watchers.join()) this.log(`наблюдатели JSON: ${out.join(', ') || '—'}`);
    this.watchers = out;
    this.broadcast({ t: 'WATCHER', profile: out[0] ?? null, profiles: out, targets });
  }

  // ---------- стратегия H1 (§7) ----------
  setStrategy(ids: string[], to: Strategy, reason: string, manual = false): string[] {
    if (manual) this.adapt.manual = true;
    const done: string[] = [];
    for (const id of ids) {
      const b = this.browsers.get(id);
      if (!b || b.strategy === to || (b.admittedAt && !manual)) continue;
      b.strategy = to;
      b.strategySwitchedAt = Date.now();
      this.send(id, { t: 'SET_STRATEGY', strategy: to, reason });
      done.push(id);
    }
    if (done.length) {
      this.log(`🔀 стратегия ${done.join(', ')} → ${to} (${reason})`);
      this.notify('strategy.switched', { browsers: done, to, reason, manual });
      this.persist();
    }
    return done;
  }

  // ---------- такт: сторож, адаптация, ворота, итог ----------
  private tick(): void {
    const now = Date.now();
    const pay = { threeDsSec: this.cfg.payment.card.threeDsTimeoutSec, applePaySec: this.cfg.payment.applePay.timeoutSec };
    if (this.cfg.watchdog.enabled) {
      for (const b of this.browsers.values()) {
        if (!b.online || b.status !== 'RUNNING' || b.stuck || b.manual) continue;
        if (isStuck(b.state, b.stateSince, now, this.cfg.watchdog.thresholds, pay, this.cfg.payment.stopBeforePay)) {
          b.stuck = true;
          const sec = Math.round((now - b.stateSince) / 1000);
          this.store.event('watchdog', { browser: b.id, state: b.state, sec });
          this.onNeedHuman(b, 'stuck', `${b.state} без изменений ${sec} с${b.detail ? `: ${b.detail}` : ''}`, b.state);
        }
      }
    }
    for (const g of this.cards.expireGrants(30_000, now)) this.grant(g.browser, g.orderId);
    const openAt = Date.parse(this.cfg.openAt);
    // терпение hold вышло — перевести на refresh тех, кого не пустило (§7)
    if (!this.holdExpired && Number.isFinite(openAt) && now >= openAt + this.cfg.fleet.holdMaxWaitSec * 1000) {
      this.holdExpired = true;
      this.setStrategy([...this.browsers.values()].filter((b) => b.strategy === 'hold' && !b.admittedAt).map((b) => b.id), 'refresh', `holdMaxWaitSec ${this.cfg.fleet.holdMaxWaitSec} с вышло`);
    }
    if (this.cfg.fleet.adaptive) {
      const fleet = [...this.browsers.values()].filter((b) => this.alive(b.id)).map((b) => ({ id: b.id, strategy: b.strategy, admittedAt: b.admittedAt, admittedStrategy: b.admittedStrategy }));
      const r = adaptTick(this.adapt, fleet, now, this.cfg.fleet.adaptiveWindowsSec[0], this.cfg.fleet.adaptiveWindowsSec[1]);
      if (r) for (const to of ['refresh', 'hold'] as Strategy[]) {
        const ids = r.switches.filter((s) => s.to === to).map((s) => s.id);
        if (ids.length) this.setStrategy(ids, to, `адаптация: ${r.reason}`);
      }
    }
    if (!this.summarySent && this.openedAt && now - this.openedAt > this.cfg.notify.summaryAfterMin * 60_000) {
      this.summarySent = true;
      this.notify('run.summary', { text: this.summaryText() });
      this.persist();
    }
    if (!this.attn.active && this.attn.items.length) this.processAttention();
  }

  summaryText(): string {
    const os = [...this.orders.values()];
    const by = (s: string) => os.filter((o) => o.state === s).length;
    const adm = [...this.browsers.values()].filter((b) => b.admittedAt);
    return `заказов оформлено ${by('ORDERED')}/${os.length}, на оплате ${by('PAY_READY') + by('PLACED')}, нужен человек ${by('NEED_HUMAN')}; пущено ${adm.length}/${this.browsers.size} (refresh ${adm.filter((b) => b.admittedStrategy === 'refresh').length}, hold ${adm.filter((b) => b.admittedStrategy === 'hold').length})`;
  }

  /** Закреплённое сообщение Telegram (§11). */
  statusText(now = Date.now()): string {
    const openAt = Date.parse(this.cfg.openAt);
    const ref = this.openedAt ?? openAt;
    const d = Math.round((now - ref) / 1000);
    const t = `${d < 0 ? 'T-' : 'T+'}${String(Math.floor(Math.abs(d) / 60)).padStart(2, '0')}:${String(Math.abs(d) % 60).padStart(2, '0')}`;
    const bs = [...this.browsers.values()].filter((b) => b.status !== 'RETIRED');
    const os = [...this.orders.values()];
    const head = `${t} · пущено ${bs.filter((b) => b.admittedAt).length}/${bs.length} · корзина ${os.filter((o) => o.inBagAt).length} · оплата ${os.filter((o) => ['PAY_READY', 'PLACED'].includes(o.state)).length} · заказов ${os.filter((o) => o.state === 'ORDERED').length}/${os.length}`;
    const rows = bs.map((b) => {
      const o = b.orderId ? this.orders.get(b.orderId) : undefined;
      const extra = o ? (o.orderNo ? `${o.id} · ${o.orderNo}` : `${o.id}${o.method === 'card' && o.cardId ? ` · ****${this.cards.get(o.cardId)?.last4}` : o.store ? ` · ${storeName(o.store).replace(/^Apple /, '')}` : ''}`) : '';
      const st = !b.online && b.status === 'RUNNING' ? 'нет связи' : b.status !== 'RUNNING' ? b.status : b.state;
      return `${b.id} ${b.strategy === 'hold' ? 'hold' : 'refr'} ${(b.proxyLabel ?? b.proxyId ?? 'dir').padEnd(5)} ${st} ${Math.round((now - b.stateSince) / 1000)}s ${extra}`.trimEnd();
    });
    return [head, ...rows].join('\n');
  }

  // ---------- HTTP / дашборд ----------
  private authed(req: http.IncomingMessage, url: URL): boolean {
    return url.searchParams.get('token') === this.dashToken || req.headers['x-token'] === this.dashToken;
  }

  private async onHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const json = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/health') return json(200, { ok: true, runId: this.runId });
    if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (!this.authed(req, url)) { res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }); res.end('нужен ?token=… (печатается при bot start)'); return; }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(dashboardHtml());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/state') return json(200, this.snapshot());
    if (req.method === 'GET' && url.pathname === '/api/orders.csv') {
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="orders-${this.cfg.machine}.csv"` });
      res.end(this.ordersCsv());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/action') {
      const body = await readBody(req);
      let a: { action: string; browser?: string; arg?: string };
      try { a = JSON.parse(body || '{}'); } catch { return json(400, { ok: false, error: 'bad json' }); }
      const r = await this.action(a.action, a.browser, a.arg);
      return json(r.ok ? 200 : 400, r);
    }
    if (req.method === 'POST' && url.pathname === '/api/test/emit' && process.env.BOT_TEST === '1') {
      const e = JSON.parse((await readBody(req)) || '{}') as { event: string; [k: string]: unknown };
      const { event, ...data } = e;
      this.notify(event, data);
      return json(200, { ok: true });
    }
    json(404, { ok: false, error: 'not found' });
  }

  private onDash(ws: WebSocket): void {
    this.dashSockets.add(ws);
    ws.on('close', () => this.dashSockets.delete(ws));
    ws.on('error', () => {});
    ws.send(JSON.stringify(this.snapshot()));
  }

  private pushDash(): void {
    if (!this.dashDirty || !this.dashSockets.size) return;
    this.dashDirty = false;
    const s = JSON.stringify(this.snapshot());
    for (const ws of this.dashSockets) if (ws.readyState === WebSocket.OPEN) ws.send(s);
  }

  /** Действия дашборда и команд Telegram (§11). */
  async action(action: string, browser?: string, arg?: string): Promise<{ ok: boolean; text?: string; error?: string }> {
    const b = browser ? this.browsers.get(browser) : undefined;
    if (browser && !b && browser !== 'all') return { ok: false, error: `нет браузера ${browser}` };
    switch (action) {
      case 'show':
        if (!b) return { ok: false, error: 'какой браузер?' };
        this.send(b.id, { t: 'COMMAND', cmd: 'focus' });
        this.fleet?.activate(b.id);
        return { ok: true, text: `${b.id} впереди` };
      case 'next':
        this.nextAttention('дашборд/Telegram');
        return { ok: true, text: `вперёд: ${this.attn.active?.browser ?? '—'}` };
      case 'stop':
        if (browser === 'all' || !b) { this.stopAll(); return { ok: true, text: 'все браузеры остановлены' }; }
        this.stopBrowser(b, 'команда «Стоп»');
        return { ok: true, text: `${b.id} остановлен` };
      case 'stopAll':
        this.stopAll();
        return { ok: true, text: 'все браузеры остановлены' };
      case 'resume': case 'manual': case 'reload': case 'reload_target': case 'snapshot':
        if (!b) return { ok: false, error: 'какой браузер?' };
        if (b.status === 'STOPPED' && action === 'resume') b.status = 'RUNNING';
        this.send(b.id, { t: 'COMMAND', cmd: action });
        if (action === 'resume' || action === 'manual') this.onHumanDone(b);
        return { ok: true, text: `${b.id}: ${action}` };
      case 'restart': {
        if (!b) return { ok: false, error: 'какой браузер?' };
        if (b.placed) return { ok: false, error: `${b.id}: Place Order уже нажат — перезапуск запрещён` };
        const o = b.orderId ? this.orders.get(b.orderId) : undefined;
        if (o) { this.dropFromOrder(o, b.id, false); b.orderId = null; b.role = null; this.reviveOrder(o, `${b.id} перезапуск`); }
        const id = await this.fleet?.relaunch(b.id, 'перезапуск вручную', { newProfile: false });
        return { ok: !!id, text: `${b.id} перезапущен` };
      }
      case 'applepay': {
        if (!b?.orderId) return { ok: false, error: 'у браузера нет заказа' };
        const o = this.orders.get(b.orderId)!;
        if (b.placed) return { ok: false, error: 'Place Order уже нажат' };
        this.cards.release(o.id);
        o.cardId = null;
        o.method = 'applepay';
        this.send(b.id, { t: 'SWITCH_PAY', orderId: o.id, method: 'applepay' });
        this.persist();
        return { ok: true, text: `${b.id} → Apple Pay` };
      }
      case 'card': {
        if (!b?.orderId || !arg) return { ok: false, error: 'нужно: браузер с заказом и id карты' };
        const o = this.orders.get(b.orderId)!;
        if (b.placed) return { ok: false, error: 'Place Order уже нажат' };
        const c = this.cards.set(o.id, arg);
        if (!c) return { ok: false, error: `карта ${arg} недоступна` };
        const def = this.sec.cards.find((x) => x.id === c.id)!;
        o.cardId = c.id;
        o.method = 'card';
        this.send(b.id, { t: 'CARD_SWAP', orderId: o.id, cardId: c.id, card: { number: def.number, expiry: def.expiry, cvv: def.cvv, name: def.name }, billing: { ...def.billing } });
        this.persist();
        return { ok: true, text: `${b.id}: карта → ****${c.last4}` };
      }
      case 'unburn': {
        const ok = !!arg && this.cards.unburn(arg);
        this.persist();
        return ok ? { ok: true, text: `карта ${arg} снова активна` } : { ok: false, error: `карта ${arg} не сгорела` };
      }
      case 'strategy': {
        const to: Strategy = arg === 'hold' ? 'hold' : 'refresh';
        const ids = browser === 'all' || !b ? [...this.browsers.keys()] : [b.id];
        const done = this.setStrategy(ids, to, 'вручную', true);
        return { ok: true, text: `стратегия ${to}: ${done.join(', ') || 'без изменений'} (автоадаптация выключена)` };
      }
      case 'status':
        return { ok: true, text: this.statusText() };
      default:
        return { ok: false, error: `неизвестное действие ${action}` };
    }
  }

  /** Общий выключатель (§20): все браузеры перестают действовать ≤ 1 с. */
  stopAll(): void {
    this.broadcast({ t: 'COMMAND', cmd: 'stop' });
    for (const b of this.browsers.values()) if (b.status === 'RUNNING' || b.status === 'STARTING') b.status = 'STOPPED';
    this.attn.items = [];
    this.attn.active = null;
    this.log('⏹ общий стоп: все браузеры остановлены', 'warn');
    this.store.event('stop.all', {});
    this.persist();
  }

  snapshot() {
    const now = Date.now();
    const browsers = [...this.browsers.values()].map((b) => {
      const o = b.orderId ? this.orders.get(b.orderId) : undefined;
      return {
        id: b.id, status: b.status, online: b.online, noLink: b.online && now - b.lastBeat > 6000, strategy: b.strategy, startStrategy: b.startStrategy,
        proxy: b.proxyLabel ?? b.proxyId ?? 'dir', exitIp: b.exitIp, state: b.state, stateSec: Math.round((now - b.stateSince) / 1000), detail: b.detail, page: b.page,
        orderId: b.orderId, role: b.role, part: o ? partLabel(o.record?.part ?? o.cfg.targets[0]) : '', store: o?.store ? storeName(o.store) : '', slot: o?.slotLabel ?? '',
        payMethod: o?.method, card: o?.method === 'card' && o.cardId ? `****${this.cards.get(o.cardId)?.last4}` : '', lastError: b.lastError, stuck: b.stuck, placed: b.placed,
        admittedSec: b.admittedAt && this.openedAt ? Math.round((b.admittedAt - this.openedAt) / 100) / 10 : null, reloads: b.reloads, pid: b.pid, cdpPort: b.cdpPort, relaunches: b.relaunches,
      };
    });
    const orders = [...this.orders.values()].map((o) => {
      const r = this.sec.recipients[o.cfg.recipient];
      return {
        id: o.id, priority: o.cfg.priority, state: o.state, leader: o.leader, claimers: o.claimers, standby: o.standby, method: o.method,
        card: o.cardId ? `****${this.cards.get(o.cardId)?.last4}` : '', orderNo: o.orderNo, store: storeName(o.store), slot: o.slotLabel, price: o.price,
        recipient: r ? `${r.firstName} ${r.lastName} · ${r.phone} · ${r.email}` : o.cfg.recipient, attempts: o.attempts,
        billingSec: o.billingAt && this.openedAt ? Math.round((o.billingAt - this.openedAt) / 100) / 10 : null,
        orderedSec: o.orderedAt && this.openedAt ? Math.round((o.orderedAt - this.openedAt) / 100) / 10 : null,
      };
    });
    return {
      now, machine: this.cfg.machine, runId: this.runId, openAt: this.cfg.openAt, openedAt: this.openedAt, openSource: this.openSource,
      stopBeforePay: this.cfg.payment.stopBeforePay, watchers: this.watchers, adapt: this.adapt,
      browsers, orders,
      cards: this.cards.cards.map((c) => ({ id: c.id, label: c.label, role: c.role, last4: c.last4, status: c.status, orders: c.orders, paid: c.paid.length, maxOrders: c.maxOrders, declines: c.declines })),
      pending: this.cards.pending, placeQueue: this.cards.queue,
      attention: { active: this.attn.active, items: this.attn.items },
      proxies: this.proxyStats(),
      log: this.logTail.slice(-300),
    };
  }

  ordersCsv(): string {
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const fmt = (t?: number) => (t ? new Date(t).toLocaleString('ru-RU') : '');
    const head = ['машина', 'заказ', 'статус', 'номер заказа', 'браузер', 'товар', 'парт', 'магазин', 'окно самовывоза', 'имя', 'фамилия', 'email', 'телефон', 'оплата', 'карта', 'сумма', 'OPEN', 'на оплате с', 'оформлен'];
    const rows = [...this.orders.values()].map((o) => {
      const r = this.sec.recipients[o.cfg.recipient];
      const part = o.record?.part ?? o.cfg.targets[0];
      return [this.cfg.machine, o.id, o.state, o.orderNo, o.leader, partLabel(part), part, storeName(o.store), o.slotLabel, r?.firstName, r?.lastName, r?.email, r?.phone,
        o.method === 'card' ? 'карта' : 'Apple Pay', o.cardId ? `****${this.cards.get(o.cardId)?.last4}` : '', o.price, fmt(this.openedAt ?? undefined), fmt(o.billingAt), fmt(o.orderedAt)].map(esc).join(';');
    });
    return '﻿' + [head.map(esc).join(';'), ...rows].join('\n');
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => { let b = ''; req.on('data', (d) => { if (b.length < 1_000_000) b += d; }); req.on('end', () => resolve(b)); });
}

/** HTML снимка без токенов Apple (x-aos-stk, atbtoken, ssi…) и номеров карт — перед записью на диск. */
export function scrubHtml(html: string): string {
  return html
    .replace(/("x-aos-stk"\s*:\s*")[^"]*"/gi, '$1…"')
    .replace(/((?:atbtoken|ssi|signKey|timeSlotId|_a_token|token)=)[^&"'\s<]*/gi, '$1…')
    .replace(/\b(?:\d[ -]?){12,18}\d\b/g, (m) => `****${m.replace(/\D/g, '').slice(-4)}`);
}

export function htmlText(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

export { last4 };
