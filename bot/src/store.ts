// Состояние на диске (BOT-SPEC §3.6): runtime/state.json (заказы, карты, браузеры ↔ прокси)
// и runtime/events.ndjson (журнал). После перезапуска оркестратор поднимает состояние и ждёт расширения.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface EventRec { ts: number; type: string; [k: string]: unknown }

export class Store {
  readonly statePath: string;
  readonly eventsPath: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: unknown = null;
  /** Подписчики на события (уведомления, дашборд). */
  private subs = new Set<(e: EventRec) => void>();

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.statePath = join(dir, 'state.json');
    this.eventsPath = join(dir, 'events.ndjson');
  }

  path(...p: string[]): string {
    return join(this.dir, ...p);
  }

  load<T>(): T | null {
    if (!existsSync(this.statePath)) return null;
    try { return JSON.parse(readFileSync(this.statePath, 'utf8')) as T; } catch { return null; }
  }

  /** Запись с задержкой 300 мс (частые изменения схлопываются). */
  save(state: unknown): void {
    this.pending = state;
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, 300);
  }

  flush(): void {
    if (this.pending === null) return;
    const tmp = `${this.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.pending, null, 1), { mode: 0o600 });
    renameSync(tmp, this.statePath);
    this.pending = null;
  }

  event(type: string, data: Record<string, unknown> = {}): EventRec {
    const e: EventRec = { ts: Date.now(), type, ...data };
    try { appendFileSync(this.eventsPath, `${JSON.stringify(e)}\n`, { mode: 0o600 }); } catch { /* диск */ }
    for (const s of this.subs) { try { s(e); } catch { /* */ } }
    return e;
  }

  onEvent(fn: (e: EventRec) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  readEvents(): EventRec[] {
    return readEvents(this.eventsPath);
  }
}

export function readEvents(path: string): EventRec[] {
  if (!existsSync(path)) return [];
  const out: EventRec[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* обрезанная строка */ }
  }
  return out;
}
