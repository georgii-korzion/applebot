// Общие переходы состояний вкладки.
import { closedReloadMs, phaseOf } from '../../shared/config';
import type { Ctl } from '../ctl';

/** STOP: заказ взят другой вкладкой/профилем — вкладка уходит в IDLE (§7.1). */
export function becomeStopped(c: Ctl, reason: string): void {
  c.stopAll();
  c.setMode('idle', { atbPendingSince: undefined });
  c.setState('STOPPED', reason);
  c.overlay.banner(null);
}

/**
 * Заглушка «Almost there» и т.п.: рефреш с джиттером (§3.10).
 * После старта — не реже раза в 4 с (очередь Apple пускает волнами, долгий бэкофф = пропуск волны);
 * до старта — по фазам; в чекауте (ночные работы) — бэкофф до 15 с.
 */
export function busyMs(c: Ctl): number {
  const n = c.ts.busyInRow++;
  const base = closedReloadMs(c.cfg, c.os.openedAt);
  if (c.ts.mode === 'checkout') return Math.min(Math.max(c.jit(c.t.postOpenReloadMs * 1.5 ** n), c.t.minReloadMs), 15000);
  if (phaseOf(c.cfg, c.os.openedAt) === 'post') return Math.min(Math.max(Math.round(base * 1.2 ** n), c.t.minReloadMs), 4000);
  return base;
}

export function busyBackoff(c: Ctl): void {
  const n = c.ts.busyInRow;
  const ms = busyMs(c);
  c.setState('BUSY', `заглушка Apple (${n + 1}), рефреш через ${ms} мс`);
  c.scheduleReload(ms, 'busy');
}
