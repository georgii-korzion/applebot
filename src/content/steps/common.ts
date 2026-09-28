// Общие переходы состояний вкладки.
import type { Ctl } from '../ctl';

/** STOP: заказ взят другой вкладкой/профилем — вкладка уходит в IDLE (§7.1). */
export function becomeStopped(c: Ctl, reason: string): void {
  c.stopAll();
  c.setMode('idle', { atbPendingSince: undefined });
  c.setState('STOPPED', reason);
  c.overlay.banner(null);
}

/** Заглушка «Almost there» и т.п.: рефреш с бэкоффом и джиттером (§3.10). */
export function busyBackoff(c: Ctl): void {
  const n = c.ts.busyInRow++;
  const ms = Math.min(Math.max(c.jit(c.t.postOpenReloadMs * 1.5 ** n), c.t.minReloadMs), 15000);
  c.setState('BUSY', `заглушка Apple (${n + 1}), рефреш через ${ms} мс`);
  c.scheduleReload(ms, 'busy');
}
