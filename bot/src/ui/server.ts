// Пульт бота: локальная страница, где владелец заполняет заказы, получателей, карты, прокси и настройки
// и запускает check / prepare / start / stop без правки JSON руками.
//   npm run bot -- ui            (на Mac — двойной клик по «Apple Drop Bot.command»)
// Слушает только 127.0.0.1, страница и API — с токеном из адресной строки; секреты пишутся с правами 600.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync, readSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import page from './page.html';
import { normalizeBotConfig, normalizeSecrets, readJsonc, validateBot, type BotConfig, type Recipient, type Secrets } from '../config';
import { PARTS, STORES, partLabel } from '../../../src/shared/parts';
import { DEFAULT_TIMING } from '../../../src/shared/config';
import { findChrome, chromeProblem, chromeVersion } from '../chrome';
import { pidAlive } from '../launcher';
import { Store } from '../store';
import { BOT_VERSION, headVersion } from '../version';

export interface UiOpts {
  root: string;
  configPath: string;
  secretsPath: string;
  /** bot/dist/bot.mjs — его же запускаем для check / start / stop. */
  bundle: string;
  port: number;
  /** не открывать браузер (тесты) — и оркестратору тоже не открывать дашборд */
  noOpen?: boolean;
}

export interface FormRecipient extends Recipient { id: string }
export interface UiForm {
  config: BotConfig;
  secrets: Omit<Secrets, 'recipients'> & { recipients: FormRecipient[] };
}

// ---------- форма ↔ файлы ----------
export function toForm(cfg: BotConfig, sec: Secrets): UiForm {
  return {
    config: cfg,
    secrets: { ...sec, recipients: Object.entries(sec.recipients).map(([id, r]) => ({ id, ...r })) },
  };
}

export function fromForm(f: UiForm): { cfg: BotConfig; sec: Secrets } {
  const s = f?.secrets ?? ({} as UiForm['secrets']);
  const recipients: Record<string, unknown> = {};
  for (const r of Array.isArray(s.recipients) ? s.recipients : []) {
    const id = String(r?.id ?? '').trim();
    if (id) recipients[id] = { firstName: r.firstName, lastName: r.lastName, email: r.email, phone: r.phone };
  }
  return { cfg: normalizeBotConfig(f?.config), sec: normalizeSecrets({ ...s, recipients }) };
}

/** Новые секреты: пустые получатели под заказы из примера и одна пустая основная карта. */
function emptySecrets(cfg: BotConfig): Secrets {
  const recipients: Record<string, Recipient> = {};
  for (const o of cfg.orders) if (o.recipient) recipients[o.recipient] = { firstName: '', lastName: '', email: '', phone: '' };
  if (!Object.keys(recipients).length) recipients.r1 = { firstName: '', lastName: '', email: '', phone: '' };
  return normalizeSecrets({ recipients, cards: [{ id: 'c1', label: 'Карта 1', role: 'primary', maxOrders: 2 }], proxies: [], telegram: {}, webhooks: [] });
}

interface Loaded { form: UiForm; notes: string[]; configExists: boolean; secretsExists: boolean }

export function loadForm(o: Pick<UiOpts, 'root' | 'configPath' | 'secretsPath'>): Loaded {
  const notes: string[] = [];
  const configExists = existsSync(o.configPath);
  const secretsExists = existsSync(o.secretsPath);
  let cfg: BotConfig;
  try {
    cfg = normalizeBotConfig(readJsonc(configExists ? o.configPath : join(o.root, 'bot/bot.config.example.jsonc')));
  } catch (e) {
    notes.push(`${configExists ? o.configPath : 'пример конфига'} не читается (${e instanceof Error ? e.message : e}) — загружены значения по умолчанию; при сохранении старый файл останется рядом как .broken`);
    cfg = normalizeBotConfig({});
  }
  let sec: Secrets;
  try {
    sec = secretsExists ? normalizeSecrets(readJsonc(o.secretsPath)) : emptySecrets(cfg);
  } catch (e) {
    notes.push(`${o.secretsPath} не читается (${e instanceof Error ? e.message : e}) — секреты пустые; при сохранении старый файл останется рядом как .broken`);
    sec = emptySecrets(cfg);
  }
  // первый запуск без прокси: все браузеры напрямую, иначе проверка сразу ругается на нехватку прокси
  if (!configExists && !sec.proxies.length) cfg.proxies.mode = 'off';
  if (!configExists) notes.push('Настройки ещё не сохранялись — показан пример. Заполни и нажми «Сохранить».');
  return { form: toForm(cfg, sec), notes, configExists, secretsExists };
}

function devBuild(root: string, cfg: BotConfig): boolean {
  const mf = join(resolve(root, cfg.fleet.extensionDir), 'manifest.json');
  try { return /\(dev\)/.test(JSON.parse(readFileSync(mf, 'utf8')).name ?? ''); } catch { return false; }
}

export function validateForm(root: string, f: UiForm): { errors: string[]; warnings: string[] } {
  const { cfg, sec } = fromForm(f);
  return validateBot(cfg, sec, { devBuild: devBuild(root, cfg) });
}

/** Атомарная запись; битый старый файл — в .broken, секреты — с правами 600. */
function writeFile(path: string, text: string, secret: boolean): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    try { readJsonc(path); } catch { renameSync(path, `${path}.broken`); if (secret) chmodSync(`${path}.broken`, 0o600); }
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: secret ? 0o600 : 0o644 });
  if (secret) chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function saveForm(o: Pick<UiOpts, 'root' | 'configPath' | 'secretsPath'>, f: UiForm): { form: UiForm; errors: string[]; warnings: string[] } {
  const { cfg, sec } = fromForm(f);
  writeFile(o.configPath, JSON.stringify(cfg, null, 2) + '\n', false);
  writeFile(o.secretsPath, JSON.stringify(sec, null, 2) + '\n', true);
  return { form: toForm(cfg, sec), ...validateBot(cfg, sec, { devBuild: devBuild(o.root, cfg) }) };
}

// ---------- каталог для выпадающих списков ----------
function catalog() {
  return {
    parts: Object.values(PARTS).map((p) => ({ part: p.part, model: p.model, label: partLabel(p.part) })),
    stores: STORES,
    cities: ['Dubai', 'Abu Dhabi', 'Sharjah', 'Ajman', 'Al Ain', 'Fujairah', 'Ras Al Khaimah', 'Umm Al Quwain'],
    events: ['order.placed', 'human.needed', 'card.declined', 'stock.gone', 'card.swapped', 'cards.exhausted', 'applepay.qr', 'pay.3ds', 'order.in_bag', 'store.opened', 'store.closed', 'browser.admitted', 'browser.blocked', 'browser.dead', 'proxy.down', 'strategy.switched', 'run.started', 'run.summary'],
    timing: Object.keys(DEFAULT_TIMING),
  };
}

// ---------- задачи (check, prepare, stop…) ----------
interface Job { id: number; kind: string; title: string; out: string; code: number | null; startedAt: number; endedAt: number | null; proc: ChildProcess | null }

const JOB_TITLES: Record<string, string> = {
  'build-ext': 'Сборка расширения (npm run build)',
  'install-chrome': 'Установка Chrome for Testing',
  check: 'Проверка машины (bot check)',
  prepare: 'Подготовка профилей (bot prepare)',
  report: 'Отчёт после дропа (bot report)',
  bench: 'Замер скорости (bot bench)',
  stop: 'Остановить всё (bot stop)',
  diag: 'Собрать логи для разработчика (bot diag)',
};
/** Эти задачи сами запускают флот на порту хаба — не вместе с работающим ботом. */
const FLEET_JOBS = new Set(['prepare', 'bench']);
const OUT_MAX = 300_000;

export class UiServer {
  readonly token = randomBytes(16).toString('hex');
  port = 0;
  private server: http.Server | null = null;
  private jobs: Job[] = [];
  private nextId = 1;
  private orch: { pid: number; startedAt: number; log: string } | null = null;
  private head: { at: number; v: string | null } | null = null;
  private chrome: { at: number; path: string; version: string | null; kind: string; problem: string | null } | null = null;

  constructor(readonly o: UiOpts) {}

  get url(): string { return `http://127.0.0.1:${this.port}/?token=${this.token}`; }

  async listen(): Promise<void> {
    for (let p = this.o.port; p < this.o.port + 20; p++) {
      const srv = http.createServer((req, res) => { void this.onHttp(req, res).catch((e) => { if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: String(e instanceof Error ? e.message : e) })); } }); });
      const ok = await new Promise<boolean>((r) => { srv.once('error', () => r(false)); srv.listen(p, '127.0.0.1', () => r(true)); });
      if (ok) { this.server = srv; this.port = p; return; }
    }
    throw new Error(`порты ${this.o.port}–${this.o.port + 19} заняты`);
  }

  async close(): Promise<void> {
    for (const j of this.jobs) if (j.proc && j.code === null) { try { j.proc.kill('SIGTERM'); } catch { /* */ } }
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  // ---------- состояние ----------
  private savedCfg(): BotConfig {
    try { return normalizeBotConfig(readJsonc(this.o.configPath)); } catch { return normalizeBotConfig(readJsonc(join(this.o.root, 'bot/bot.config.example.jsonc'))); }
  }

  private chromeInfo(cfg: BotConfig): { path: string; version: string | null; kind: string; problem: string | null } | null {
    if (this.chrome && Date.now() - this.chrome.at < 60_000) return this.chrome;
    const c = findChrome(cfg.fleet.chromePath, this.o.root);
    if (!c) { this.chrome = null; return null; }
    const version = chromeVersion(c.path);
    this.chrome = { at: Date.now(), path: c.path, version, kind: c.kind, problem: chromeProblem(c, version) };
    return this.chrome;
  }

  async status(): Promise<Record<string, unknown>> {
    const cfg = this.savedCfg();
    const rt = resolve(this.o.root, cfg.runtimeDir);
    const hubUp = await fetch(`http://127.0.0.1:${cfg.hub.port}/health`, { signal: AbortSignal.timeout(800) }).then((r) => r.ok).catch(() => false);
    const st = new Store(rt).load<{ dashToken?: string; browsers?: Record<string, { pid?: number; status?: string }> }>();
    const live = Object.values(st?.browsers ?? {}).filter((b) => b.status !== 'RETIRED' && pidAlive(b.pid)).length;
    const extDir = resolve(this.o.root, cfg.fleet.extensionDir);
    const busy = this.jobs.filter((j) => j.code === null).map((j) => j.kind);
    if (!this.head || Date.now() - this.head.at > 10_000) this.head = { at: Date.now(), v: headVersion(this.o.root) };
    return {
      platform: process.platform,
      node: process.version,
      version: BOT_VERSION,
      head: this.head.v,
      stale: this.stale(),
      configExists: existsSync(this.o.configPath),
      secretsExists: existsSync(this.o.secretsPath),
      ext: { dir: cfg.fleet.extensionDir, built: existsSync(join(extDir, 'manifest.json')) },
      chrome: this.chromeInfo(cfg),
      running: hubUp,
      orchestratorAlive: !!this.orch && pidAlive(this.orch.pid),
      orchestratorPid: this.orch?.pid ?? null,
      liveBrowsers: live,
      dashUrl: hubUp && st?.dashToken ? `http://127.0.0.1:${cfg.hub.port}/?token=${st.dashToken}` : null,
      ordersFile: join(rt, cfg.notify.file.path),
      busy,
      jobs: this.jobs.slice(-8).map((j) => this.jobView(j, false)),
    };
  }

  private jobView(j: Job, withOut = true) {
    return { id: j.id, kind: j.kind, title: j.title, code: j.code, running: j.code === null, startedAt: j.startedAt, endedAt: j.endedAt, ...(withOut ? { out: j.out } : {}) };
  }

  private cliArgs(): string[] {
    return ['--config', this.o.configPath, '--secrets', this.o.secretsPath];
  }

  async runJob(kind: string, opts: { runs?: number; browsers?: string } = {}): Promise<{ ok: boolean; error?: string; job?: unknown }> {
    if (!JOB_TITLES[kind]) return { ok: false, error: `нет такой задачи: ${kind}` };
    if (this.jobs.some((j) => j.kind === kind && j.code === null)) return { ok: false, error: `${JOB_TITLES[kind]} уже идёт` };
    if (FLEET_JOBS.has(kind) || kind === 'check') {
      if (!existsSync(this.o.configPath) || !existsSync(this.o.secretsPath)) return { ok: false, error: 'сначала сохрани настройки' };
    }
    if (FLEET_JOBS.has(kind)) {
      const s = await this.status();
      if (s.running) return { ok: false, error: 'бот уже запущен — сначала «Остановить всё»' };
      if ((s.busy as string[]).some((k) => FLEET_JOBS.has(k))) return { ok: false, error: 'уже идёт prepare или bench' };
    }
    let args: string[];
    if (kind === 'build-ext') args = [join(this.o.root, 'build.mjs')];
    else if (kind === 'install-chrome') args = [this.o.bundle, 'install-chrome'];
    else if (kind === 'bench') args = [this.o.bundle, 'bench', ...this.cliArgs(), ...(opts.runs ? ['--runs', String(opts.runs)] : []), ...(opts.browsers ? ['--browsers', opts.browsers] : [])];
    else args = [this.o.bundle, kind, ...this.cliArgs()];
    const job: Job = { id: this.nextId++, kind, title: JOB_TITLES[kind], out: '', code: null, startedAt: Date.now(), endedAt: null, proc: null };
    const ch = spawn(process.execPath, args, { cwd: this.o.root, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    job.proc = ch;
    const add = (d: Buffer) => { job.out += String(d); if (job.out.length > OUT_MAX) job.out = '…\n' + job.out.slice(-OUT_MAX); };
    ch.stdout?.on('data', add);
    ch.stderr?.on('data', add);
    ch.on('error', (e) => { add(Buffer.from(`\n✗ ${e.message}\n`)); });
    ch.on('close', (code, sig) => {
      job.code = code ?? (sig ? 143 : 1);
      job.endedAt = Date.now();
      job.proc = null;
      if (kind === 'install-chrome' || kind === 'build-ext') this.chrome = null;
    });
    this.jobs.push(job);
    if (this.jobs.length > 30) this.jobs.splice(0, this.jobs.length - 30);
    return { ok: true, job: this.jobView(job) };
  }

  cancelJob(id: number): boolean {
    const j = this.jobs.find((x) => x.id === id);
    if (!j?.proc || j.code !== null) return false;
    try { j.proc.kill('SIGTERM'); } catch { /* */ }
    return true;
  }

  // ---------- запуск флота ----------
  async start(fresh: boolean): Promise<{ ok: boolean; error?: string; errors?: string[]; pid?: number }> {
    if (!existsSync(this.o.configPath) || !existsSync(this.o.secretsPath)) return { ok: false, error: 'сначала сохрани настройки' };
    let cfg: BotConfig;
    let sec: Secrets;
    try {
      cfg = normalizeBotConfig(readJsonc(this.o.configPath));
      sec = normalizeSecrets(readJsonc(this.o.secretsPath));
    } catch (e) {
      return { ok: false, error: `настройки не читаются: ${e instanceof Error ? e.message : e}` };
    }
    const v = validateBot(cfg, sec, { devBuild: devBuild(this.o.root, cfg) });
    if (v.errors.length) return { ok: false, error: 'в настройках есть ошибки', errors: v.errors };
    const s = await this.status();
    if (s.stale) return { ok: false, error: `код бота обновился (${BOT_VERSION} → ${s.head}) — закрой окно Терминала с пультом и снова дважды кликни «Apple Drop Bot.command»` };
    if (s.running) return { ok: false, error: 'бот уже запущен' };
    if ((s.busy as string[]).some((k) => FLEET_JOBS.has(k))) return { ok: false, error: 'идёт prepare или bench — дождись конца' };
    if (!(s.ext as { built: boolean }).built) return { ok: false, error: `расширение не собрано (${cfg.fleet.extensionDir}/) — кнопка «Собрать расширение»` };
    this.chrome = null;
    const chrome = this.chromeInfo(cfg);
    if (!chrome) return { ok: false, error: 'не найден Chrome for Testing — кнопка «Установить» на вкладке «Запуск»' };
    if (chrome.problem) return { ok: false, error: chrome.problem };
    const rt = resolve(this.o.root, cfg.runtimeDir);
    mkdirSync(rt, { recursive: true });
    const log = join(rt, 'orchestrator.log');
    const fd = openSync(log, 'w');
    const args = [this.o.bundle, 'start', ...this.cliArgs(), ...(fresh ? ['--fresh'] : []), ...(this.o.noOpen ? ['--no-open'] : [])];
    const ch = spawn(process.execPath, args, { cwd: this.o.root, detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } });
    closeSync(fd);
    ch.on('error', () => { /* причина — в orchestrator.log или ниже */ });
    ch.unref();
    if (!ch.pid) return { ok: false, error: 'оркестратор не запустился' };
    this.orch = { pid: ch.pid, startedAt: Date.now(), log };
    // Mac не засыпает, пока жив оркестратор (BOT-SPEC §4: caffeinate)
    if (process.platform === 'darwin') {
      const caf = spawn('caffeinate', ['-dims', '-w', String(ch.pid)], { detached: true, stdio: 'ignore' });
      caf.on('error', () => { /* нет caffeinate — bot check об этом скажет */ });
      caf.unref();
    }
    return { ok: true, pid: ch.pid };
  }

  /** После git pull пульт и бандл бота старые: запускать с ними нельзя — перезапустить пульт (он всё пересоберёт). */
  private stale(): boolean {
    const h = this.head?.v;
    return !!h && BOT_VERSION !== 'dev' && BOT_VERSION !== 'zip' && h !== BOT_VERSION;
  }

  orchestratorLog(): string {
    const cfg = this.savedCfg();
    const p = this.orch?.log ?? join(resolve(this.o.root, cfg.runtimeDir), 'orchestrator.log');
    return tail(p, 60_000);
  }

  ordersText(): { path: string; text: string } {
    const cfg = this.savedCfg();
    const p = join(resolve(this.o.root, cfg.runtimeDir), cfg.notify.file.path);
    return { path: p, text: tail(p, 400_000) };
  }

  // ---------- HTTP ----------
  private hostOk(req: http.IncomingMessage): boolean {
    const h = String(req.headers.host ?? '');
    return h === `127.0.0.1:${this.port}` || h === `localhost:${this.port}`;
  }

  private async onHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const json = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    // защита от DNS rebinding: только свой адрес
    if (!this.hostOk(req)) { res.writeHead(421); res.end(); return; }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      if (url.searchParams.get('token') !== this.token) { res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Открой ссылку, которую напечатал npm run bot -- ui (в ней токен).'); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
      res.end(page);
      return;
    }
    // API: токен только в заголовке — чужая страница его не подставит (CORS не разрешаем)
    if (req.headers['x-token'] !== this.token) return json(403, { ok: false, error: 'нет токена' });
    if (req.method === 'GET' && url.pathname === '/api/load') {
      const l = loadForm(this.o);
      return json(200, { ok: true, ...l, catalog: catalog(), paths: { config: this.o.configPath, secrets: this.o.secretsPath }, ...validateForm(this.o.root, l.form) });
    }
    if (req.method === 'GET' && url.pathname === '/api/status') return json(200, { ok: true, ...(await this.status()) });
    if (req.method === 'GET' && url.pathname === '/api/job') {
      const j = this.jobs.find((x) => x.id === Number(url.searchParams.get('id')));
      return j ? json(200, { ok: true, job: this.jobView(j) }) : json(404, { ok: false, error: 'нет задачи' });
    }
    if (req.method === 'GET' && url.pathname === '/api/orchestrator-log') return json(200, { ok: true, text: this.orchestratorLog() });
    if (req.method === 'GET' && url.pathname === '/api/orders') return json(200, { ok: true, ...this.ordersText() });
    if (req.method !== 'POST') return json(404, { ok: false, error: 'not found' });
    if (!/^application\/json/.test(String(req.headers['content-type'] ?? ''))) return json(415, { ok: false, error: 'нужен JSON' });
    let body: any;
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return json(400, { ok: false, error: 'bad json' }); }
    switch (url.pathname) {
      case '/api/validate': return json(200, { ok: true, ...validateForm(this.o.root, body.form) });
      case '/api/save': return json(200, { ok: true, ...saveForm(this.o, body.form) });
      case '/api/job': return json(200, await this.runJob(String(body.kind), body));
      case '/api/job/cancel': return json(200, { ok: this.cancelJob(Number(body.id)) });
      case '/api/start': return json(200, await this.start(!!body.fresh));
      default: return json(404, { ok: false, error: 'not found' });
    }
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((res, rej) => {
    let s = '';
    req.on('data', (d) => { s += d; if (s.length > 2_000_000) { rej(new Error('слишком большой запрос')); req.destroy(); } });
    req.on('end', () => res(s));
    req.on('error', rej);
  });
}

function tail(path: string, max: number): string {
  try {
    const size = statSync(path).size;
    const fd = openSync(path, 'r');
    try {
      const len = Math.min(size, max);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      return (size > max ? '…\n' : '') + buf.toString('utf8');
    } finally { closeSync(fd); }
  } catch {
    return '';
  }
}

export async function runUi(o: UiOpts): Promise<UiServer> {
  const ui = new UiServer(o);
  await ui.listen();
  console.log(`\nПульт бота: ${ui.url}\n(ссылка открывается сама; Ctrl+C — закрыть пульт, запущенный бот продолжит работать)\n`);
  if (!o.noOpen) {
    if (process.platform === 'darwin') spawnSync('open', [ui.url]);
    else if (process.platform === 'win32') spawnSync('cmd', ['/c', 'start', '', ui.url]);
    else spawnSync('xdg-open', [ui.url], { stdio: 'ignore' });
  }
  const quit = () => { void ui.close().then(() => process.exit(0)); };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
  return ui;
}
