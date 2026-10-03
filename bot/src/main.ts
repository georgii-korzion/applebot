// CLI бота (BOT-SPEC §3): check | prepare | start | status | stop | report | bench | wipe | install-chrome
//   npm run bot -- start [--config bot.config.json] [--secrets secrets.local.json] [--fresh]
import { existsSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { normalizeBotConfig, normalizeSecrets, readJsonc, validateBot, type BotConfig, type Secrets } from './config';
import { startOrchestrator } from './orchestrator';
import { runCheck } from './check';
import { buildReport } from './report';
import { runBench } from './bench';
import { pidAlive } from './launcher';
import { Store } from './store';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Args { cmd: string; config: string; secrets: string; flags: Set<string>; opts: Record<string, string> }

function parseArgs(argv: string[]): Args {
  const flags = new Set<string>();
  const opts: Record<string, string> = {};
  let cmd = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) opts[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--') && ['config', 'secrets', 'runs', 'browsers'].includes(k)) opts[k] = argv[++i];
      else flags.add(k);
    } else if (!cmd) cmd = a;
  }
  return { cmd: cmd || 'help', config: opts.config ?? 'bot.config.json', secrets: opts.secrets ?? 'secrets.local.json', flags, opts };
}

function load(a: Args): { cfg: BotConfig; sec: Secrets } {
  const cp = resolve(a.config);
  if (!existsSync(cp)) throw new Error(`нет ${a.config} — скопируй bot/bot.config.example.jsonc в bot.config.json и заполни`);
  const sp = resolve(a.secrets);
  if (!existsSync(sp)) throw new Error(`нет ${a.secrets} — скопируй bot/secrets.example.jsonc в secrets.local.json, заполни, chmod 600`);
  try { if ((statSync(sp).mode & 0o077) !== 0) chmodSync(sp, 0o600); } catch { /* */ }
  return { cfg: normalizeBotConfig(readJsonc(cp)), sec: normalizeSecrets(readJsonc(sp)) };
}

function devBuild(cfg: BotConfig): boolean {
  const mf = join(resolve(ROOT, cfg.fleet.extensionDir), 'manifest.json');
  return existsSync(mf) && /\(dev\)/.test(JSON.parse(readFileSync(mf, 'utf8')).name ?? '');
}

function printValidation(v: { errors: string[]; warnings: string[] }): void {
  for (const e of v.errors) console.log(`✗ ${e}`);
  for (const w of v.warnings) console.log(`⚠ ${w}`);
}

async function hubCall(cfg: BotConfig, action: string, browser?: string, arg?: string): Promise<any> {
  const st = new Store(resolve(ROOT, cfg.runtimeDir)).load<{ dashToken: string }>();
  if (!st) throw new Error('оркестратор не запускался');
  const r = await fetch(`http://127.0.0.1:${cfg.hub.port}/api/action`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-token': st.dashToken }, body: JSON.stringify({ action, browser, arg }), signal: AbortSignal.timeout(5000) });
  return r.json();
}

async function cmdStart(a: Args, mode: 'run' | 'prepare' = 'run'): Promise<void> {
  const { cfg, sec } = load(a);
  const v = validateBot(cfg, sec, { devBuild: devBuild(cfg) });
  printValidation(v);
  if (v.errors.length) { console.log('\nБот не запущен: исправь ошибки выше.'); process.exit(1); }
  const orch = await startOrchestrator(cfg, sec, ROOT, { mode, fresh: a.flags.has('fresh') });
  const url = `http://127.0.0.1:${cfg.hub.port}/?token=${orch.hub.dashToken}`;
  console.log(`\nДашборд: ${url}\nЗаказы: ${join(resolve(ROOT, cfg.runtimeDir), cfg.notify.file.path)}\nCtrl+C — выйти из оркестратора (браузеры продолжат сами); npm run bot -- stop — закрыть браузеры.\n`);
  if (!cfg.fleet.headless && process.platform === 'darwin' && !a.flags.has('no-open')) spawnSync('open', [url]);
  let closing = false;
  const quit = async (kill: boolean) => {
    if (closing) return;
    closing = true;
    await orch.stop(kill);
    console.log(kill ? 'Оркестратор и браузеры остановлены.' : 'Оркестратор остановлен; браузеры работают дальше и доведут свои заказы сами.');
    process.exit(0);
  };
  process.on('SIGINT', () => void quit(false));
  process.on('SIGTERM', () => void quit(false));
  // bot stop → /api/action shutdown
  const origAction = orch.hub.action.bind(orch.hub);
  orch.hub.action = async (action, browser, arg) => {
    if (action === 'shutdown') { setTimeout(() => void quit(true), 200); return { ok: true, text: 'останавливаю' }; }
    return origAction(action, browser, arg);
  };
  if (mode === 'prepare') {
    const end = Date.now() + 180_000;
    while (Date.now() < end) {
      const bs = [...orch.hub.browsers.values()].filter((b) => b.status !== 'RETIRED');
      if (bs.every((b) => b.prepared)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.log('\nPrepare:');
    for (const b of orch.hub.browsers.values()) console.log(`${b.prepared?.ok ? '✓' : '✗'} ${b.id} (${b.proxyLabel ?? 'dir'}): ${b.prepared?.detail ?? 'нет ответа за 3 мин'}`);
    await quit(true);
  }
}

async function cmdStop(a: Args): Promise<void> {
  const { cfg } = load(a);
  const r = await hubCall(cfg, 'shutdown').catch(() => null);
  if (r?.ok) { console.log('Оркестратор останавливает браузеры…'); await new Promise((res) => setTimeout(res, 1500)); }
  const st = new Store(resolve(ROOT, cfg.runtimeDir)).load<{ browsers: Record<string, { pid?: number; status?: string }> }>();
  let n = 0;
  for (const [id, b] of Object.entries(st?.browsers ?? {})) {
    if (pidAlive(b.pid)) { try { process.kill(b.pid!, 'SIGTERM'); n++; console.log(`закрыт ${id} (PID ${b.pid})`); } catch { /* */ } }
  }
  console.log(n || r?.ok ? 'Готово.' : 'Живых браузеров нет.');
}

async function cmdStatus(a: Args): Promise<void> {
  const { cfg } = load(a);
  const st = new Store(resolve(ROOT, cfg.runtimeDir)).load<{ dashToken: string }>();
  const s = st ? await fetch(`http://127.0.0.1:${cfg.hub.port}/api/state?token=${st.dashToken}`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).catch(() => null) : null;
  if (!s) { console.log('Оркестратор не запущен.'); return; }
  const r = await hubCall(cfg, 'status');
  console.log(r.text);
  console.log(`\nДашборд: http://127.0.0.1:${cfg.hub.port}/?token=${st!.dashToken}`);
}

async function cmdWipe(a: Args): Promise<void> {
  const { cfg } = load(a);
  const rt = resolve(ROOT, cfg.runtimeDir);
  if (!a.flags.has('yes')) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ans = await rl.question(`Удалить ${a.secrets}, профили браузеров и ${cfg.runtimeDir}/ (кроме отчёта и таблицы заказов)? Напиши «да»: `);
    rl.close();
    if (ans.trim().toLowerCase() !== 'да') { console.log('Отменено.'); return; }
  }
  // таблица заказов из state.json — до удаления
  try { buildReport(rt); } catch { /* */ }
  const st = new Store(rt).load<any>();
  if (st?.orders) {
    const rows = Object.values(st.orders as Record<string, any>).map((o) => [o.id, o.state, o.orderNo ?? '', o.leader ?? '', o.store ?? '', o.slotLabel ?? '', o.price ?? ''].join(';'));
    writeFileSync(join(rt, 'orders.csv'), '﻿заказ;статус;номер;браузер;магазин;окно;сумма\n' + rows.join('\n'));
  }
  const keep = new Set(['report.md', 'orders.csv', cfg.notify.file.path]);
  if (existsSync(rt)) for (const f of readdirSync(rt)) if (!keep.has(f) && !f.startsWith('bench-')) rmSync(join(rt, f), { recursive: true, force: true });
  rmSync(resolve(a.secrets), { force: true });
  console.log(`Удалено: ${a.secrets}, профили, расширения, снимки, состояние. Остались: ${[...keep].join(', ')}.`);
}

function cmdInstallChrome(): void {
  console.log('Ставлю Chrome for Testing в runtime/chrome (≈200 МБ)…');
  const r = spawnSync('npx', ['--yes', '@puppeteer/browsers', 'install', 'chrome@stable', '--path', join(ROOT, 'runtime', 'chrome')], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

const HELP = `Apple Drop Bot (docs/BOT-SPEC.md)
  npm run bot -- check            проверка машины, Chrome, расширения, прокси, конфига и секретов
  npm run bot -- prepare          прогрев профилей (страна, корзина, цель в AED) и отчёт по браузерам
  npm run bot -- start [--fresh]  запуск флота и дашборда (--fresh — новый запуск, живые браузеры закрыть)
  npm run bot -- status           состояние браузеров и заказов
  npm run bot -- stop             закрыть все браузеры (и оркестратор, если запущен)
  npm run bot -- report           отчёт после дропа: какая стратегия сработала, блокировки по IP
  npm run bot -- bench [--runs 5] [--browsers 1,10,20]   замер скорости до Review (stopBeforePay)
  npm run bot -- wipe [--yes]     удалить секреты, профили и runtime/ (кроме отчёта и заказов)
  npm run bot -- install-chrome   поставить Chrome for Testing
Опции: --config bot.config.json --secrets secrets.local.json`;

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const a = parseArgs(argv);
  switch (a.cmd) {
    case 'start': return cmdStart(a, 'run');
    case 'prepare': return cmdStart(a, 'prepare');
    case 'stop': return cmdStop(a);
    case 'status': return cmdStatus(a);
    case 'check': {
      const { cfg, sec } = load(a);
      const r = await runCheck(cfg, sec, ROOT, { skipNet: a.flags.has('offline') });
      for (const l of r.lines) console.log(`${{ ok: '✓', warn: '⚠', err: '✗', info: '·' }[l.level]} ${l.text}`);
      console.log(r.ok ? '\nbot check: готово к запуску.' : '\nbot check: есть ошибки (✗).');
      process.exit(r.ok ? 0 : 1);
    }
    case 'report': {
      const { cfg } = load(a);
      console.log(buildReport(resolve(ROOT, cfg.runtimeDir)));
      return;
    }
    case 'bench': {
      const { cfg, sec } = load(a);
      const sizes = (a.opts.browsers ?? cfg.bench.browsers.join(',')).split(',').map(Number).filter((n) => n > 0);
      console.log(await runBench(cfg, sec, ROOT, { sizes, runs: Number(a.opts.runs ?? cfg.bench.runs) }));
      process.exit(0);
    }
    case 'wipe': return cmdWipe(a);
    case 'install-chrome': return cmdInstallChrome();
    default:
      console.log(HELP);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(`✗ ${e instanceof Error ? e.message : e}`); process.exit(1); });
}
