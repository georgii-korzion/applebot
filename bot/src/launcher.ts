// Лаунчер (BOT-SPEC §4): запуск и надзор за процессами Chrome. Один браузер = свой --user-data-dir =
// одна сессия Apple = одна корзина. Браузеры отвязаны от оркестратора (detached): его падение не роняет покупку.
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { BotConfig, Secrets } from './config';
import { chromeArgs, chromeVersion, findChrome, majorOf, type ChromeBin } from './chrome';
import { Forwarder, parseProxyUrl, redactProxy, httpsGetVia } from './proxy/forwarder';
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

export class Launcher implements FleetOps {
  chrome: ChromeBin | null;
  chromeVer: string | null = null;
  forwarders = new Map<string, Forwarder>();
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
    const strategies = assignStrategies(n, this.cfg.fleet.strategyMix, [directIdx, proxyIdx]);
    for (let i = 0; i < n; i++) {
      const id = `b${String(this.hub.nextBrowserNo++).padStart(2, '0')}`;
      const openJitter = this.cfg.fleet.openJitter === 'all' ? true : this.cfg.fleet.openJitter === 'none' ? false : i % 2 === 0;
      const b = this.hub.blankBrowser(id, randomBytes(16).toString('hex'), strategies[i], openJitter, proxies[i], this.profileDir(id), this.extDir(id));
      b.proxyLabel = this.label(proxies[i]);
      this.hub.addBrowser(b);
    }
    this.log(`флот: ${n} браузеров · ${strategies.filter((s) => s === 'hold').length} hold / ${strategies.filter((s) => s === 'refresh').length} refresh · прямых ${proxies.filter((p) => !p).length}, через прокси ${proxies.filter(Boolean).length}`);
  }

  /** Свободные места на прокси (с учётом maxBrowsersPerProxy и уже занятых). */
  private proxySlots(exclude = new Set<string>()): string[] {
    const used = new Map<string, number>();
    for (const b of this.hub.browsers.values()) if (b.proxyId && b.status !== 'RETIRED') used.set(b.proxyId, (used.get(b.proxyId) ?? 0) + 1);
    const out: string[] = [];
    for (let round = 0; round < this.cfg.proxies.maxBrowsersPerProxy; round++) {
      for (const p of this.sec.proxies) {
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
  private async forwarder(proxyId: string): Promise<Forwarder> {
    const have = this.forwarders.get(proxyId);
    if (have) return have;
    const i = this.sec.proxies.findIndex((p) => p.id === proxyId);
    const def = this.sec.proxies[i];
    const f = new Forwarder(proxyId, parseProxyUrl(def.url), this.cfg.proxies.basePort + i, { probe: this.cfg.proxies.probe, downAfterSec: this.cfg.proxies.downAfterSec });
    await f.start();
    f.on('down', (err: string) => this.hub.onProxyDown(proxyId, err));
    f.on('up', () => this.hub.onProxyUp(proxyId));
    this.forwarders.set(proxyId, f);
    this.log(`форвардер ${def.label}: 127.0.0.1:${f.port} → ${redactProxy(def.url)}`);
    // выходной IP — для статуса и отчёта (без сети просто не узнаем)
    void httpsGetVia(f.upstream, 'https://api.ipify.org?format=json', 6000).then((r) => {
      const ip = /"ip"\s*:\s*"([^"]+)"/.exec(r.body)?.[1];
      if (!ip) return;
      for (const b of this.hub.browsers.values()) if (b.proxyId === proxyId) b.exitIp = ip;
      this.hub.store.event('proxy.ip', { proxy: proxyId, ip });
    }).catch(() => {});
    return f;
  }

  // ---------- запуск ----------
  /** Поднять весь флот: живые (после перезапуска оркестратора) подхватить, остальные запустить с разносом. */
  async startAll(): Promise<void> {
    if (!this.chrome) throw new Error('Chrome не найден — см. bot check (нужен Chrome for Testing: npm run bot -- install-chrome)');
    this.plan();
    const list = [...this.hub.browsers.values()].filter((b) => b.status !== 'RETIRED' && b.status !== 'STOPPED');
    let launched = 0;
    for (const b of list) {
      if (pidAlive(b.pid) && b.cdpPort && (await Cdp.version(b.cdpPort, 1500))) {
        b.status = 'RUNNING';
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

  /** Подхваченные процессы (не наши дети) — проверка PID раз в секунду. */
  private watchPids(): void {
    for (const b of this.hub.browsers.values()) {
      if (this.procs.has(b.id) || !b.pid || b.status === 'DEAD' || b.status === 'RETIRED' || b.status === 'STOPPED') continue;
      if (!pidAlive(b.pid)) this.hub.onDead(b.id, null);
    }
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
    for (const f of this.forwarders.values()) f.stop();
    clearInterval(this.watchTimer);
    this.hub.persist();
  }

  activate(id: string): void {
    const b = this.hub.browsers.get(id);
    if (b?.pid) void activatePid(b.pid);
  }

  stopForwarders(): void {
    for (const f of this.forwarders.values()) f.stop();
  }
}
