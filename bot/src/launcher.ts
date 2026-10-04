// Лаунчер (BOT-SPEC §4): запуск и надзор за процессами Chrome. Один браузер = свой --user-data-dir =
// одна сессия Apple = одна корзина. Браузеры отвязаны от оркестратора (detached): его падение не роняет покупку.
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { BotConfig, Secrets } from './config';
import { chromeArgs, chromeProblem, chromeVersion, findChrome, majorOf, type ChromeBin } from './chrome';
import { forwarderStatus, parseProxyUrl, redactProxy, httpsGetVia, type ForwarderStatus } from './proxy/forwarder';
import { fileURLToPath } from 'node:url';
import type { BrowserRt, FleetOps, Hub } from './hub/server';
import { assignStrategies } from './hub/policy';
import { activatePid, screenSize } from './os';
import { Cdp } from './cdp';
import { partUrl } from '../../src/shared/parts';

export function pidAlive(pid?: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const MAX_RELAUNCHES = 5;
interface ProxyDefLite { id: string; label: string; url: string; i: number; bad: number }
const BUNDLE = fileURLToPath(import.meta.url);

/** Форвардер прокси — отдельный отвязанный процесс (переживает оркестратор, §3.5). */
export interface FwdRt { id: string; port: number; pid?: number; up: boolean; status?: ForwarderStatus & { targets?: Record<string, number> } }

export class Launcher implements FleetOps {
  chrome: ChromeBin | null;
  chromeVer: string | null = null;
  forwarders = new Map<string, FwdRt>();
  private fwdTimer: ReturnType<typeof setInterval> | undefined;
  private procs = new Map<string, ChildProcess>();
  private watchTimer: ReturnType<typeof setInterval> | undefined;
  private blockedProxies = new Set<string>();
  private screen: { width: number; height: number };
  private slot = 0;

  constructor(private cfg: BotConfig, private sec: Secrets, private hub: Hub, private root: string, private log: (m: string, l?: 'info' | 'warn' | 'error') => void) {
    this.chrome = findChrome(cfg.fleet.chromePath, root);
    if (this.chrome) this.chromeVer = chromeVersion(this.chrome.path);
    this.screen = cfg.fleet.screen ?? screenSize() ?? { width: 1920, height: 1080 };
  }

  get extSource(): string {
    return resolve(this.root, this.cfg.fleet.extensionDir);
  }

  private label(proxyId: string | null): string {
    return proxyId ? this.sec.proxies.find((p) => p.id === proxyId)?.label ?? proxyId : 'dir';
  }

  /** План флота при первом старте: прокси и стратегии (§4, §7, §8). */
  plan(): void {
    if (this.hub.browsers.size) return;
    const n = this.cfg.fleet.browsers;
    const proxies: (string | null)[] = [];
    const slots = this.proxySlots();
    for (let i = 0; i < n; i++) {
      const direct = this.cfg.proxies.mode === 'off' || (this.cfg.proxies.mode === 'mixed' && i < this.cfg.proxies.directBrowsers);
      proxies.push(direct ? null : slots.shift() ?? null);
    }
    const directIdx = proxies.map((p, i) => (p ? -1 : i)).filter((i) => i >= 0);
    const proxyIdx = proxies.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
    // по стоку ждать на заглушке незачем (товар уже продаётся) — все refresh
    const strategies = assignStrategies(n, this.cfg.start.mode === 'stock' ? { refresh: 1, hold: 0 } : this.cfg.fleet.strategyMix, [directIdx, proxyIdx]);
    for (let i = 0; i < n; i++) {
      const id = `b${String(this.hub.nextBrowserNo++).padStart(2, '0')}`;
      const openJitter = this.cfg.fleet.openJitter === 'all' ? true : this.cfg.fleet.openJitter === 'none' ? false : i % 2 === 0;
      const b = this.hub.blankBrowser(id, randomBytes(16).toString('hex'), strategies[i], openJitter, proxies[i], this.profileDir(id), this.extDir(id));
      b.proxyLabel = this.label(proxies[i]);
      this.hub.addBrowser(b);
    }
    this.log(`флот: ${n} браузеров · ${strategies.filter((s) => s === 'hold').length} hold / ${strategies.filter((s) => s === 'refresh').length} refresh · прямых ${proxies.filter((p) => !p).length}, через прокси ${proxies.filter(Boolean).length}`);
  }

  /**
   * Порядок прокси: по результатам bot check (runtime/proxy-check.json) медленные (вдвое медленнее прямого канала),
   * не из нужной страны и с ошибкой — в конец, то есть в запасные (§20.9).
   */
  private proxyOrder(): ProxyDefLite[] {
    let check: { directMs?: number; results?: Record<string, { ms?: number; country?: string; error?: string }> } = {};
    try { check = JSON.parse(readFileSync(join(this.hub.store.dir, 'proxy-check.json'), 'utf8')); } catch { /* bot check не запускали */ }
    const bad = (id: string) => {
      const r = check.results?.[id];
      if (!r) return 0;
      if (r.error) return 2;
      if (r.country && r.country !== this.cfg.proxies.requireCountry) return 1;
      if (check.directMs && r.ms && r.ms > check.directMs * 2) return 1;
      return 0;
    };
    return [...this.sec.proxies].map((p, i) => ({ ...p, i, bad: bad(p.id) })).sort((a, b) => a.bad - b.bad || a.i - b.i);
  }

  /** Свободные места на прокси (с учётом maxBrowsersPerProxy и уже занятых). */
  private proxySlots(exclude = new Set<string>()): string[] {
    const used = new Map<string, number>();
    for (const b of this.hub.browsers.values()) if (b.proxyId && b.status !== 'RETIRED') used.set(b.proxyId, (used.get(b.proxyId) ?? 0) + 1);
    const out: string[] = [];
    for (let round = 0; round < this.cfg.proxies.maxBrowsersPerProxy; round++) {
      for (const p of this.proxyOrder()) {
        if (exclude.has(p.id) || this.blockedProxies.has(p.id)) continue;
        if ((used.get(p.id) ?? 0) <= round) { out.push(p.id); used.set(p.id, (used.get(p.id) ?? 0) + 1); }
      }
    }
    return out;
  }

  spareProxy(): string | null {
    const down = new Set([...this.forwarders.values()].filter((f) => !f.up).map((f) => f.id));
    return this.proxySlots(down)[0] ?? null;
  }

  private profileDir(id: string): string { return join(this.hub.store.dir, 'profiles', id); }
  private extDir(id: string): string { return join(this.hub.store.dir, 'ext', id); }

  // ---------- прокси ----------
  private async forwarder(proxyId: string): Promise<FwdRt> {
    const have = this.forwarders.get(proxyId);
    if (have) return have;
    const i = this.sec.proxies.findIndex((p) => p.id === proxyId);
    const def = this.sec.proxies[i];
    const port = this.cfg.proxies.basePort + i;
    let st = await forwarderStatus(port);
    if (st && st.id !== proxyId) throw new Error(`порт ${port} занят чужим форвардером (${st.id})`);
    if (!st) {
      mkdirSync(join(this.hub.store.dir, 'logs'), { recursive: true });
      const out = openSync(join(this.hub.store.dir, 'logs', `forwarder-${proxyId}.log`), 'a');
      const ch = spawn(process.execPath, [BUNDLE, 'forwarder', '--id', proxyId, '--port', String(port), '--probe', this.cfg.proxies.probe, '--down', String(this.cfg.proxies.downAfterSec)], {
        detached: true, stdio: ['ignore', out, out], env: { ...process.env, PROXY_URL: def.url },
      });
      ch.unref();
      for (let k = 0; k < 40 && !st; k++) { await new Promise((r) => setTimeout(r, 100)); st = await forwarderStatus(port, 500); }
      if (!st) throw new Error(`форвардер ${def.label} не запустился (порт ${port})`);
      this.log(`форвардер ${def.label}: 127.0.0.1:${port} → ${redactProxy(def.url)} (PID ${st.pid})`);
    } else this.log(`форвардер ${def.label} уже работает (PID ${st.pid}) — подхватываю`);
    const f: FwdRt = { id: proxyId, port, pid: st.pid, up: st.up, status: st };
    this.forwarders.set(proxyId, f);
    this.hub.forwarders[proxyId] = { pid: st.pid, port };
    this.hub.persist();
    if (!this.fwdTimer) this.fwdTimer = setInterval(() => void this.pollForwarders(), 2000);
    // выходной IP — для статуса и отчёта (без сети просто не узнаем)
    void httpsGetVia(parseProxyUrl(def.url), 'https://api.ipify.org?format=json', 6000).then((r) => {
      const ip = /"ip"\s*:\s*"([^"]+)"/.exec(r.body)?.[1];
      if (!ip) return;
      for (const b of this.hub.browsers.values()) if (b.proxyId === proxyId) b.exitIp = ip;
      this.hub.store.event('proxy.ip', { proxy: proxyId, ip });
    }).catch(() => {});
    return f;
  }

  /** Живость прокси (проба внутри форвардера) и самого процесса форвардера. */
  private async pollForwarders(): Promise<void> {
    for (const f of this.forwarders.values()) {
      const st = await forwarderStatus(f.port);
      if (!st) {
        // процесс форвардера пропал — поднять снова (браузеры ходят на тот же порт)
        if (f.up) { f.up = false; this.hub.onProxyDown(f.id, 'форвардер не отвечает — перезапускаю'); }
        this.forwarders.delete(f.id);
        await this.forwarder(f.id).catch((e) => this.log(`форвардер ${f.id}: ${e instanceof Error ? e.message : e}`, 'error'));
        continue;
      }
      f.status = st;
      f.pid = st.pid;
      if (st.up !== f.up) {
        f.up = st.up;
        if (st.up) this.hub.onProxyUp(f.id); else this.hub.onProxyDown(f.id, st.lastError ?? 'нет ответа');
      }
    }
  }

  stats(): unknown[] {
    return [...this.forwarders.values()].map((f) => ({ id: f.id, port: f.port, pid: f.pid, up: f.up, ...(f.status ?? {}) }));
  }

  // ---------- запуск ----------
  /** Поднять весь флот: живые (после перезапуска оркестратора) подхватить, остальные запустить с разносом. */
  async startAll(): Promise<void> {
    if (!this.chrome) throw new Error('Chrome не найден — см. bot check (нужен Chrome for Testing: npm run bot -- install-chrome)');
    const problem = chromeProblem(this.chrome, this.chromeVer);
    if (problem) throw new Error(`${this.chrome.path}: ${problem}`);
    this.plan();
    const list = [...this.hub.browsers.values()].filter((b) => b.status !== 'RETIRED' && b.status !== 'STOPPED');
    let launched = 0;
    for (const b of list) {
      if (pidAlive(b.pid) && b.cdpPort && (await Cdp.version(b.cdpPort, 1500))) {
        b.status = 'RUNNING';
        // подхваченный браузер тоже должен подключиться — иначе сторож запуска объяснит почему
        b.launchedAt = Date.now();
        b.noConnectAt = undefined;
        this.log(`${b.id}: уже работает (PID ${b.pid}) — подхватываю`);
        if (b.proxyId) await this.forwarder(b.proxyId);
        continue;
      }
      if (launched++) await new Promise((r) => setTimeout(r, this.cfg.fleet.launchStaggerMs));
      await this.launch(b);
    }
    clearInterval(this.watchTimer);
    this.watchTimer = setInterval(() => this.watchPids(), 1000);
  }

  private window(): { x: number; y: number; width: number; height: number } {
    const { width: w, height: h } = this.cfg.fleet.window;
    const cols = Math.max(1, Math.floor(this.screen.width / w));
    const rows = Math.max(1, Math.floor((this.screen.height - 25) / h));
    const i = this.slot++;
    const layer = Math.floor(i / (cols * rows));
    const k = i % (cols * rows);
    return { x: (k % cols) * w + layer * 30, y: 25 + Math.floor(k / cols) * h + layer * 30, width: w, height: h };
  }

  async launch(b: BrowserRt): Promise<void> {
    const src = this.extSource;
    if (!existsSync(join(src, 'manifest.json'))) throw new Error(`нет сборки расширения ${src} — npm run build`);
    rmSync(b.extDir, { recursive: true, force: true });
    mkdirSync(b.extDir, { recursive: true });
    cpSync(src, b.extDir, { recursive: true });
    writeFileSync(join(b.extDir, 'bootstrap.json'), JSON.stringify({ browserId: b.id, hubUrl: this.hub.hubUrl, token: b.token, machine: this.cfg.machine }), { mode: 0o600 });
    mkdirSync(b.profileDir, { recursive: true });
    const num = Number(b.id.replace(/\D/g, '')) || 1;
    b.cdpPort = this.cfg.fleet.cdp ? this.cfg.fleet.cdpBasePort + num : undefined;
    let proxyPort: number | undefined;
    if (b.proxyId) proxyPort = (await this.forwarder(b.proxyId)).port;
    b.forwarderPort = proxyPort;
    const top = [...this.cfg.orders].sort((x, y) => x.priority - y.priority)[0];
    const url = top?.targets[0] ? partUrl(this.cfg.baseUrl, top.targets[0]) : `${this.cfg.baseUrl}/ae/`;
    const args = chromeArgs({
      profileDir: b.profileDir, extDir: b.extDir, url, proxyPort, cdpPort: b.cdpPort, window: this.window(),
      headless: this.cfg.fleet.headless, mockKeychain: this.cfg.fleet.mockKeychain, bypassLoopback: this.cfg.proxies.bypassLoopback,
      branded: this.chrome!.kind === 'chrome' && majorOf(this.chromeVer) >= 137, extraArgs: this.cfg.fleet.extraArgs,
    });
    mkdirSync(join(this.hub.store.dir, 'logs'), { recursive: true });
    const out = openSync(join(this.hub.store.dir, 'logs', `${b.id}.chrome.log`), 'a');
    const ch = spawn(this.chrome!.path, args, { detached: true, stdio: ['ignore', out, out] });
    ch.unref();
    b.pid = ch.pid;
    b.status = 'STARTING';
    b.launchedAt = Date.now();
    b.noConnectAt = undefined;
    b.online = false;
    b.state = 'STARTING';
    b.stateSince = Date.now();
    this.procs.set(b.id, ch);
    ch.on('exit', (code) => {
      if (this.procs.get(b.id) !== ch) return;
      this.procs.delete(b.id);
      if (b.status === 'RETIRED' || b.status === 'STOPPED') return;
      this.hub.onDead(b.id, code);
    });
    this.hub.persist();
    this.hub.store.event('launch', { browser: b.id, strategy: b.strategy, proxy: b.proxyId, proxyLabel: b.proxyLabel, pid: b.pid, cdpPort: b.cdpPort });
    this.log(`${b.id}: запущен PID ${b.pid} (${b.strategy}, ${b.proxyLabel ?? 'dir'}${b.cdpPort ? `, CDP :${b.cdpPort}` : ''})`);
  }

  /** Раз в секунду: подхваченные процессы (не наши дети) — по PID; запущенные, но не подключившиеся — сторож запуска. */
  private watchPids(): void {
    const now = Date.now();
    for (const b of this.hub.browsers.values()) {
      if (!b.pid || b.status === 'DEAD' || b.status === 'RETIRED' || b.status === 'STOPPED') continue;
      if (!this.procs.has(b.id) && !pidAlive(b.pid)) { this.hub.onDead(b.id, null); continue; }
      if (this.waitingConnect(b) && now - b.launchedAt! > this.cfg.fleet.connectTimeoutSec * 1000) void this.noConnect(b);
    }
  }

  private diagnosing = new Set<string>();

  /** Запущен или подхвачен, а расширение с тех пор так и не подключилось к хабу. */
  private waitingConnect(b: BrowserRt): boolean {
    if (!b.launchedAt || b.noConnectAt || b.online || b.status === 'PROXY_DOWN') return false;
    return !(b.connectedAt && b.connectedAt >= b.launchedAt);
  }

  /** Браузер открылся, но расширение не подключилось к хабу — один раз объяснить почему (лог, дашборд, уведомление). */
  private async noConnect(b: BrowserRt): Promise<void> {
    if (this.diagnosing.has(b.id)) return;
    this.diagnosing.add(b.id);
    try {
      const why = await this.diagnoseNoConnect(b);
      if (!this.waitingConnect(b)) return;
      b.noConnectAt = Date.now();
      b.lastError = why;
      this.log(`${b.id}: не подключился к боту за ${this.cfg.fleet.connectTimeoutSec} с — ${why}`, 'error');
      this.hub.store.event('browser.no_connect', { browser: b.id, why });
      // одно уведомление на запуск: обычно причина у всех браузеров одна
      const others = [...this.hub.browsers.values()].filter((x) => x.id !== b.id && x.noConnectAt);
      if (!others.length) this.hub.notify('human.needed', { browser: b.id, reason: 'start', text: why });
      this.hub.persist();
    } finally {
      this.diagnosing.delete(b.id);
    }
  }

  private async diagnoseNoConnect(b: BrowserRt): Promise<string> {
    const logFile = join(this.hub.store.dir, 'logs', `${b.id}.chrome.log`);
    const rel = `runtime/logs/${b.id}.chrome.log`;
    let log = '';
    try { log = readFileSync(logFile, 'utf8').slice(-20_000); } catch { /* */ }
    if (/load-extension[^\n]{0,80}not allowed|not allowed[^\n]{0,80}load-extension/i.test(log) || (this.chrome && chromeProblem(this.chrome, this.chromeVer))) {
      return 'Chrome не загрузил расширение: обычный Google Chrome не принимает расширения из командной строки. Нужен Chrome for Testing — в пульте «Установить» (или npm run bot -- install-chrome), потом запусти бота заново.';
    }
    if (!b.cdpPort) return `расширение не подключилось — в окне ${b.id} открой chrome://extensions и посмотри ошибку (лог Chrome: ${rel})`;
    const targets = await fetch(`http://127.0.0.1:${b.cdpPort}/json/list`, { signal: AbortSignal.timeout(2500) }).then((r) => r.json() as Promise<{ type?: string; url?: string }[]>).catch(() => null);
    if (!targets) return `Chrome не отвечает на порту отладки :${b.cdpPort} — окно зависло или порт занят (лог Chrome: ${rel})`;
    if (!targets.some((t) => String(t.url ?? '').startsWith('chrome-extension://'))) {
      // подхваченное окно прошлого запуска (не наш дочерний процесс) — скорее всего открыто не тем Chrome
      if (!this.procs.has(b.id)) return `в окне ${b.id} (открыто прошлым запуском) расширение не работает — нажми «■ Остановить всё», потом «▶ Запустить»: окна откроются заново в ${this.chrome?.kind === 'cft' ? 'Chrome for Testing' : 'нужном Chrome'}`;
      return `расширение не загрузилось — в окне ${b.id} открой chrome://extensions: там будет ошибка (лог Chrome: ${rel}). Сборка: ${this.cfg.fleet.extensionDir}/ — в пульте «Пересобрать»`;
    }
    return `расширение загрузилось, но не подключилось к боту (${this.hub.hubUrl.replace(/\?.*$/, '')}) — в окне ${b.id}: chrome://extensions → Apple Drop Assistant → «service worker» → Console`;
  }

  async relaunch(id: string, reason: string, opts: { newProfile: boolean; proxyId?: string | null }): Promise<string | null> {
    const old = this.hub.browsers.get(id);
    if (!old) return null;
    if (old.placed) { this.log(`${id}: Place Order нажат — перезапуск запрещён`, 'warn'); return null; }
    if (opts.newProfile) {
      if (old.proxyId) this.blockedProxies.add(old.proxyId);
      old.status = 'RETIRED';
      this.kill(id);
      old.retiredReason = reason;
      const nid = `b${String(this.hub.nextBrowserNo++).padStart(2, '0')}`;
      const proxyId = opts.proxyId === undefined ? old.proxyId : opts.proxyId;
      const b = this.hub.blankBrowser(nid, randomBytes(16).toString('hex'), old.strategy, old.openJitter, proxyId, this.profileDir(nid), this.extDir(nid));
      b.proxyLabel = this.label(proxyId);
      b.startStrategy = old.startStrategy;
      this.hub.addBrowser(b);
      this.log(`${id} → новый браузер ${nid} на ${b.proxyLabel} (${reason})`);
      this.hub.store.event('relaunch', { browser: id, newBrowser: nid, proxy: proxyId, reason });
      await this.launch(b);
      return nid;
    }
    if (old.relaunches >= MAX_RELAUNCHES) { this.log(`${id}: ${old.relaunches} перезапусков — хватит, нужен человек`, 'error'); return null; }
    this.kill(id);
    old.status = 'STARTING';
    old.pid = undefined;
    old.relaunches++;
    await new Promise((r) => setTimeout(r, 1500));
    this.log(`${id}: перезапуск с тем же профилем и прокси (${reason})`);
    this.hub.store.event('relaunch', { browser: id, newBrowser: id, proxy: old.proxyId, reason });
    old.admittedAt = undefined;
    await this.launch(old);
    return id;
  }

  kill(id: string): void {
    const b = this.hub.browsers.get(id);
    const ch = this.procs.get(id);
    this.procs.delete(id);
    if (ch) { try { ch.kill('SIGTERM'); } catch { /* */ } }
    if (b?.pid && pidAlive(b.pid)) { try { process.kill(b.pid, 'SIGTERM'); } catch { /* */ } }
  }

  killAll(): void {
    for (const b of this.hub.browsers.values()) {
      if (b.status !== 'RETIRED') b.status = 'STOPPED';
      this.kill(b.id);
    }
    clearInterval(this.watchTimer);
    clearInterval(this.fwdTimer);
    for (const [id, f] of Object.entries(this.hub.forwarders)) if (pidAlive(f.pid)) { try { process.kill(f.pid!, 'SIGTERM'); } catch { /* */ } this.log(`форвардер ${id} остановлен`); }
    this.forwarders.clear();
    this.hub.persist();
  }

  activate(id: string): void {
    const b = this.hub.browsers.get(id);
    if (b?.pid) void activatePid(b.pid);
  }

  /** Выход оркестратора без остановки: форвардеры (отдельные процессы) остаются — браузеры доводят заказы. */
  detach(): void {
    clearInterval(this.watchTimer);
    clearInterval(this.fwdTimer);
  }
}
