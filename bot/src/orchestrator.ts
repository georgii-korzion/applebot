// Сборка оркестратора: хаб + лаунчер + форвардеры + уведомления (BOT-SPEC §3). Используется bot start, prepare, bench.
import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BotConfig, Secrets } from './config';
import { Store } from './store';
import { Hub } from './hub/server';
import { Launcher, pidAlive } from './launcher';
import { Notifier } from './notify';
import type { TgCommand } from './notify/telegram';

export interface Orchestrator { hub: Hub; launcher: Launcher; notifier: Notifier; store: Store; stop(kill: boolean): Promise<void> }

/** Есть ли в state.json живые браузеры прошлого запуска (тогда — подхватываем, а не начинаем заново). */
export function hasLiveRun(runtimeDir: string): boolean {
  const st = new Store(runtimeDir).load<{ browsers?: Record<string, { pid?: number; status?: string }> }>();
  return !!st && Object.values(st.browsers ?? {}).some((b) => b.status !== 'RETIRED' && b.status !== 'STOPPED' && pidAlive(b.pid));
}

/** --fresh: закрыть браузеры прошлого запуска. */
export function killRun(runtimeDir: string): void {
  const st = new Store(runtimeDir).load<{ browsers?: Record<string, { pid?: number }>; forwarders?: Record<string, { pid?: number }> }>();
  for (const b of [...Object.values(st?.browsers ?? {}), ...Object.values(st?.forwarders ?? {})]) if (pidAlive(b.pid)) { try { process.kill(b.pid!, 'SIGTERM'); } catch { /* */ } }
}

/** Новый запуск: прошлое состояние и журнал — в runtime/archive/<время>/ (профили остаются: они прогреты). */
export function archiveRun(runtimeDir: string): void {
  const files = ['state.json', 'events.ndjson', 'hub.log', 'notify.txt'];
  if (!files.some((f) => existsSync(join(runtimeDir, f)))) return;
  const dir = join(runtimeDir, 'archive', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  for (const f of files) if (existsSync(join(runtimeDir, f))) renameSync(join(runtimeDir, f), join(dir, f));
  for (const d of ['snapshots', 'logs']) {
    const p = join(runtimeDir, d);
    if (existsSync(p) && readdirSync(p).length) renameSync(p, join(dir, d));
  }
}

export async function startOrchestrator(cfg: BotConfig, sec: Secrets, root: string, opts: { mode?: 'run' | 'prepare'; fresh?: boolean; launch?: boolean } = {}): Promise<Orchestrator> {
  const runtimeDir = resolve(root, cfg.runtimeDir);
  mkdirSync(runtimeDir, { recursive: true });
  const live = hasLiveRun(runtimeDir);
  const resume = !opts.fresh && live;
  // новый запуск: браузеры и форвардеры прошлого запуска закрыть (форвардер мог остаться со старым паролем прокси)
  if (!resume) killRun(runtimeDir);
  if (!resume) archiveRun(runtimeDir);
  const store = new Store(runtimeDir);
  const saved = resume ? store.load<any>() : null;
  const hub = new Hub(cfg, sec, store, saved);
  hub.mode = opts.mode ?? 'run';
  const log = (m: string, l: 'info' | 'warn' | 'error' = 'info') => hub.log(m, l);
  const onCommand = (c: TgCommand) => telegramCommand(hub, c);
  const notifier = new Notifier(cfg, sec, { orders: join(runtimeDir, cfg.notify.file.path), notify: join(runtimeDir, 'notify.txt') }, log, onCommand);
  hub.notifier = notifier;
  const launcher = new Launcher(cfg, sec, hub, root, log);
  hub.fleet = launcher;
  hub.proxyStats = () => launcher.stats();
  await hub.listen();
  notifier.start(() => hub.statusText());
  if (resume) log(`перезапуск оркестратора: подхватываю запуск ${hub.runId} (живые браузеры не трогаю)`);
  if (opts.launch !== false) {
    await launcher.startAll();
    if (!resume && hub.mode === 'run') {
      hub.notify('run.started', {
        browsers: cfg.fleet.browsers, orders: cfg.orders.length, cards: sec.cards.length, proxies: sec.proxies.length,
        openAt: cfg.openAt, stopBeforePay: cfg.payment.stopBeforePay, strategies: { hold: [...hub.browsers.values()].filter((b) => b.strategy === 'hold').length },
      });
    }
  }
  return {
    hub, launcher, notifier, store,
    async stop(kill: boolean) {
      if (kill) launcher.killAll();
      else launcher.detach();
      notifier.stop();
      hub.close();
    },
  };
}

/** Команды Telegram (§11) — только от allowedUserIds (проверяет клиент Telegram). */
export async function telegramCommand(hub: Hub, c: TgCommand): Promise<string> {
  const a = c.args;
  const res = async (action: string, browser?: string, arg?: string) => {
    const r = await hub.action(action, browser, arg);
    return r.ok ? r.text ?? 'ok' : `✗ ${r.error}`;
  };
  switch (c.cmd) {
    case 'status': case 'start': return hub.statusText();
    case 'show': return res('show', a[0]);
    case 'next': return res('next');
    case 'stop': return res('stop', a[0] ?? 'all');
    case 'applepay': return res('applepay', a[0]);
    case 'resume': return res('resume', a[0]);
    case 'card':
      if (a[0] === 'unburn') return res('unburn', undefined, a[1]);
      return res('card', a[0], a[1]);
    case 'strategy': return res('strategy', a[0] === 'all' ? 'all' : a[0], a[1]);
    case 'summary': return hub.summaryText();
    default:
      return 'команды: /status · /show b07 · /next · /stop b07|all · /resume b07 · /applepay b07 · /card unburn c1 · /card b07 c3 · /strategy all refresh|hold · /summary';
  }
}
