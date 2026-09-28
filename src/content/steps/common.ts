// Общие переходы состояний вкладки.
import { closedReloadMs, phaseOf } from '../../shared/config';
import type { Ctl } from '../ctl';
import type { PageInfo } from '../classify';

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

export function busyBackoff(c: Ctl, page?: PageInfo): void {
  const n = c.ts.busyInRow;
  const ms = busyMs(c);
  const meta = page?.metaRefreshSec;
  if (meta !== undefined && meta <= 60) {
    // страница обновит себя сама (это и есть «очередь» Apple) — наш рефреш только страховка
    const wait = Math.max((meta + 5) * 1000, ms);
    c.setState('BUSY', `заглушка Apple (${n + 1}) обновится сама через ${meta} с — не мешаем`);
    c.scheduleReload(wait, 'busy-meta-fallback');
    return;
  }
  c.setState('BUSY', `заглушка Apple (${n + 1}), рефреш через ${ms} мс`);
  c.scheduleReload(ms, 'busy');
}

/**
 * Страница очереди Apple (iPhone 18 Pro, 12.09.2026: «will open the order page when it has reached your spot
 * in the queue»). Рефреш может сбросить место — ждём, пока страница сама уйдёт дальше, до queueMaxWaitSec.
 */
export function queueStep(c: Ctl, page: PageInfo): void {
  c.ts.queueSince ??= Date.now();
  const waited = Date.now() - c.ts.queueSince;
  const max = c.t.queueMaxWaitSec * 1000;
  if (waited >= max) {
    c.log(`очередь: страница не пустила за ${Math.round(waited / 1000)} с — перезагружаю`, 'warn');
    c.ts.queueSince = undefined;
    c.setState('QUEUE', 'лимит ожидания очереди вышел — рефреш');
    c.scheduleReload(0, 'queue-timeout');
    return;
  }
  const left = max - waited;
  const meta = page.metaRefreshSec;
  c.setState('QUEUE', `очередь Apple — страницу не трогаем${meta !== undefined ? ` (сама обновится через ${meta} с)` : ''}, лимит ещё ${Math.round(left / 1000)} с`);
  c.renderOverlay({ timerSince: c.ts.queueSince, timerLabel: 'в очереди' });
  c.timer(left, () => c.rerun('queue-timeout'));
}
