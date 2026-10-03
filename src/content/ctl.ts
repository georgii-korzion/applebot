// Контроллер вкладки: связь с SW, состояние (§6), таймеры, навигация. Шаги получают его как `c`.
import type { Config, OrderCfg } from '../shared/config';
import { K, jitter } from '../shared/config';
import type { C2S, OrderState, Role, S2C, TabState, Mode } from '../shared/messages';
import { newTabState } from '../shared/messages';
import { partUrl } from '../shared/parts';
import { Aborted, sleep } from './dom';
import { Overlay } from './overlay';
import { addNavigation, perf, resetPerf } from './perf';
import type { HumanReason, StepPerf } from '../shared/bot';

type Welcome = Extract<S2C, { t: 'WELCOME' }>;

export class Ctl {
  port: chrome.runtime.Port | null = null;
  connected = false;
  tabId = -1;
  windowId = -1;
  profileId = '';
  cfg!: Config;
  order: OrderCfg | null = null;
  os!: OrderState;
  ts: TabState = newTabState();
  role: Role = 'idle';
  hub = false;
  overlay!: Overlay;
  /** Последний успешный опрос страховочного поллера в SW (сообщение SW_WATCH). */
  swWatchAt = 0;
  /** Режим бота (BOT-SPEC): конфиг от хаба, заказ назначается после ADMITTED. */
  bot = false;
  /** Класс текущей страницы (для пульса STATE в хаб). */
  pageKind = '';
  pageStep = '';

  private ac = new AbortController();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private waiters = new Map<string, (m: S2C) => void>();
  private netSubs = new Set<(acpartNone: boolean, at: number) => void>();
  private welcomeResolve: ((w: Welcome) => void) | null = null;
  private lastLogged = '';
  private errorsInRow = 0;
  private pingTimer: ReturnType<typeof setInterval> | undefined;

  /** Обработчики сообщений SW, которые ставит index.ts. */
  onMessage: (m: S2C) => void = () => {};
  dispatch: (c: Ctl) => Promise<void> = async () => {};

  get signal(): AbortSignal { return this.ac.signal; }
  get t() { return this.cfg.timing; }
  /** Настройки бота (только в режиме бота). */
  get b() { return this.cfg.bot; }
  /** Режим бота, заказа ещё нет (ждём ASSIGN). */
  get lobby(): boolean { return this.bot && !!this.order?.lobby; }
  get base(): string { return this.cfg.baseUrl; }

  target(): string {
    return this.ts.target ?? this.os.activeTarget ?? this.order?.targets[0] ?? '';
  }
  targetUrl(): string { return partUrl(this.cfg.baseUrl, this.target()); }
  bagUrl(): string { return `${this.cfg.baseUrl}/ae/shop/bag`; }
  jit(ms: number): number { return jitter(ms, this.t.jitterPct); }

  // ---------- связь с SW ----------
  connect(): Promise<Welcome> {
    return new Promise((resolve) => {
      this.welcomeResolve = resolve;
      this.openPort();
    });
  }

  private openPort(): void {
    try {
      this.port = chrome.runtime.connect({ name: 'tab' });
    } catch {
      // контекст расширения потерян (обновили расширение) — страница должна перезагрузиться
      return;
    }
    this.connected = true;
    this.port.onMessage.addListener((m: S2C) => this.handle(m));
    this.port.onDisconnect.addListener(() => {
      this.connected = false;
      this.port = null;
      if (chrome.runtime?.id) setTimeout(() => this.openPort(), 300);
    });
    this.port.postMessage({ t: 'HELLO', url: location.href, kind: document.title, mode: this.ts.mode, state: this.ts.state } satisfies C2S);
    clearInterval(this.pingTimer);
    // сообщения по порту продлевают жизнь service worker'а
    this.pingTimer = setInterval(() => this.send({ t: 'PING' }), 20000);
  }

  send(m: C2S): void {
    try { this.port?.postMessage(m); } catch { /* порт закрыт — переподключимся */ }
  }

  /** Запрос к SW с ответом заданного типа; null — таймаут или шаг прерван (signal). */
  request<T extends S2C['t']>(m: C2S, reply: T, timeout: number, signal?: AbortSignal): Promise<Extract<S2C, { t: T }> | null> {
    return new Promise((resolve) => {
      const done = (x: Extract<S2C, { t: T }> | null) => { clearTimeout(to); signal?.removeEventListener('abort', onAbort); if (this.waiters.get(reply) === waiter) this.waiters.delete(reply); resolve(x); };
      const onAbort = () => done(null);
      const to = setTimeout(() => done(null), timeout);
      const waiter = (x: S2C) => done(x as Extract<S2C, { t: T }>);
      this.waiters.set(reply, waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.send(m);
    });
  }

  onNet(cb: (acpartNone: boolean, at: number) => void): () => void {
    this.netSubs.add(cb);
    return () => this.netSubs.delete(cb);
  }

  private handle(m: S2C): void {
    if (m.t === 'WELCOME') {
      const first = !!this.welcomeResolve;
      this.tabId = m.tabId;
      this.windowId = m.windowId;
      this.profileId = m.profileId;
      this.cfg = m.cfg;
      this.order = m.order;
      this.os = m.os;
      this.role = m.role;
      this.hub = m.hub;
      this.bot = !!m.bot;
      if (first) {
        this.ts = m.ts;
        this.ts.stateSince ??= Date.now();
        resetPerf(this.ts.perf);
        addNavigation();
        this.welcomeResolve!(m);
        this.welcomeResolve = null;
      }
      this.onMessage(m);
      return;
    }
    if (m.t === 'NET') { for (const cb of this.netSubs) cb(m.acpartNone, m.at); return; }
    if (m.t === 'SW_WATCH') { if (m.ok) this.swWatchAt = m.at; return; }
    const w = this.waiters.get(m.t);
    if (w) { w(m); return; }
    this.onMessage(m);
  }

  // ---------- состояние ----------
  async save(): Promise<void> {
    this.ts.updatedAt = Date.now();
    try { await chrome.storage.session.set({ [K.tab(this.tabId)]: this.ts }); } catch { /* */ }
  }

  setState(state: string, detail?: string, patch: Partial<TabState> = {}): void {
    Object.assign(this.ts, patch);
    const changed = this.ts.state !== state || this.ts.detail !== detail;
    let stepPerf: StepPerf | undefined;
    if (this.ts.state !== state) {
      // время шага для bot bench (§20): всего / сеть / ожидание / пауза
      const now = Date.now();
      stepPerf = { state: this.ts.state, ms: now - (this.ts.stateSince ?? now), net: Math.round(perf.net), wait: Math.round(perf.wait), pause: Math.round(perf.pause) };
      this.ts.stateSince = now;
      resetPerf();
    }
    this.ts.perf = { net: perf.net, wait: perf.wait, pause: perf.pause };
    this.ts.state = state;
    this.ts.detail = detail;
    void this.save();
    this.send({
      t: 'STATE', state, mode: this.ts.mode, detail, outcome: this.ts.lastOutcome,
      counters: { reloads: this.ts.reloads, atb404: this.ts.atb404InRow },
      page: this.pageKind, step: this.pageStep, since: this.ts.stateSince, perf: stepPerf,
    });
    const line = `${state}${detail ? ` — ${detail}` : ''}`;
    if (changed && line !== this.lastLogged) {
      this.lastLogged = line;
      this.send({ t: 'LOG', level: /STUCK|ERROR|TIMEOUT/.test(state) ? 'warn' : 'info', msg: detail ?? '', state });
    }
    this.renderOverlay();
  }

  setMode(mode: Mode, patch: Partial<TabState> = {}): void {
    this.ts.mode = mode;
    Object.assign(this.ts, patch);
    void this.save();
  }

  log(msg: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.send({ t: 'LOG', level, msg, state: this.ts.state });
  }

  renderOverlay(extra: Partial<Parameters<Overlay['update']>[0]> = {}): void {
    if (!this.overlay) return;
    this.overlay.update({
      profile: this.profileId,
      order: this.order?.id ?? '—',
      state: this.ts.state,
      detail: this.ts.detail,
      role: this.role === 'idle' ? this.ts.mode : this.role,
      reloads: this.ts.reloads,
      atb404: this.ts.atb404InRow,
      paused: this.ts.paused,
      ...extra,
    });
  }

  // ---------- запуск шагов ----------
  /** Прерывает текущий шаг и запускает диспетчер заново (после загрузки, смены _s, команды SW). */
  rerun(reason: string): void {
    this.ac.abort();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.ac = new AbortController();
    const sig = this.ac.signal;
    setTimeout(async () => {
      if (sig.aborted) return;
      try {
        await this.dispatch(this);
        this.errorsInRow = 0;
      } catch (e) {
        if (e instanceof Aborted || sig.aborted) return;
        this.errorsInRow++;
        const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        this.log(`ошибка шага (${reason}): ${msg}`, 'error');
        if (this.errorsInRow >= 5) {
          this.setState('STUCK', `повторяющаяся ошибка: ${msg}`);
          this.alert('Вкладка застряла', msg);
        } else {
          this.timer(2000, () => this.rerun('retry-after-error'));
        }
      }
    }, 0);
  }

  /** Таймер в рамках текущего шага: сбрасывается при rerun(). */
  timer(ms: number, fn: () => void): void {
    const sig = this.ac.signal;
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!sig.aborted) fn();
    }, Math.max(0, ms));
    this.timers.add(t);
  }

  stopAll(): void {
    this.ac.abort();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.ac = new AbortController();
  }

  // ---------- навигация ----------
  async navigate(url: string, why: string, rateLimited = false): Promise<void> {
    if (rateLimited) await this.respectMinReload();
    if (rateLimited) { this.ts.reloads++; this.ts.lastReloadAt = Date.now(); }
    if (this.order && url === this.targetUrl()) this.ts.lastTargetNavAt = Date.now();
    await this.save();
    this.log(`→ ${why}: ${url.replace(this.base, '')}`);
    location.assign(url);
  }

  async reload(why: string): Promise<void> {
    await this.respectMinReload();
    this.ts.reloads++;
    this.ts.lastReloadAt = Date.now();
    await this.save();
    if (this.ts.reloads % 20 === 1) this.log(`reload #${this.ts.reloads} (${why})`);
    location.reload();
  }

  private async respectMinReload(): Promise<void> {
    const since = Date.now() - (this.ts.lastReloadAt ?? 0);
    const min = this.t.minReloadMs;
    if (since < min) await sleep(min - since, this.signal);
  }

  scheduleReload(ms: number, why: string): void {
    this.timer(Math.max(ms, 0), () => { void this.reload(why); });
  }

  // ---------- ассистент / уведомления ----------
  assistFor(step: 'atb' | 'checkout' | 'guest'): boolean {
    return this.cfg.mode === 'assist' || (this.ts.fails[step] ?? 0) >= this.t.assistAfterFailures;
  }

  fail(step: string): number {
    this.ts.fails[step] = (this.ts.fails[step] ?? 0) + 1;
    return this.ts.fails[step];
  }

  alert(title: string, msg: string): void {
    this.send({ t: 'ALERT', title, msg, sound: 'alert' });
  }

  /** Режим бота: позвать человека через очередь внимания хаба (§10). */
  needHuman(reason: HumanReason, text: string): void {
    if (this.bot) this.send({ t: 'NEED_HUMAN', reason, step: this.ts.state, text });
  }

  /** Лок Add to Bag от SW (§7.1). false — заказ уже в корзине другой вкладки. */
  async acquireLock(ttl: number): Promise<boolean> {
    let noAnswer = 0;
    for (;;) {
      if (this.signal.aborted) throw new Aborted();
      const r = await this.request({ t: 'ATB_LOCK_REQ', ttl }, 'ATB_LOCK', 2500);
      if (r?.granted) return true;
      if (r?.reason === 'inBag') return false;
      if (!r) {
        noAnswer++;
        if (noAnswer >= 3) {
          this.log('SW не отвечает на ATB_LOCK_REQ — жму без лока', 'warn');
          return true;
        }
      }
      this.setState('ATB_WAIT_LOCK', r ? `лок у другой вкладки (${r.reason ?? ''})` : 'ждём SW');
      await sleep(this.jit(400), this.signal);
    }
  }
}
