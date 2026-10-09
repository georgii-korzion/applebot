// Общие переходы состояний вкладки и ожидание по стратегии (FLEET-SPEC §4.2 через waitPlan).
import { phaseOf, type Strategy } from '../../shared/config';
import { waitPlan } from '../../shared/strategy';
import type { Ctl } from '../ctl';
import type { PageInfo } from '../classify';

/** STOP: заказ взят другой вкладкой — вкладка уходит в IDLE (§7.1). */
export function becomeStopped(c: Ctl, reason: string): void {
  c.stopAll();
  c.setMode('idle', { atbPendingSince: undefined });
  c.setState('STOPPED', reason);
  c.overlay.banner(null);
}

/** Стратегия вкладки: hold, пока не исчерпан holdFallbackSec (флаг переживает перезагрузку); после своего OPEN — без разницы. */
export function effectiveStrategy(c: Ctl): Strategy {
  return c.cfg.strategy === 'hold' && !c.ts.holdFallback ? 'hold' : 'refresh';
}

/** hold не дождался своего OPEN — дальше вкладка ведёт себя как refresh. */
export function holdFallback(c: Ctl, why: string): void {
  if (c.ts.holdFallback) return;
  c.ts.holdFallback = true;
  void c.save();
  c.log(`hold не дождался ${why} за ${c.t.holdFallbackSec} с — перехожу на refresh`, 'warn');
}

/** Заглушка в чекауте (ночные работы Apple): бэкофф до 15 с. */
export function busyMs(c: Ctl): number {
  const n = c.ts.busyInRow++;
  return Math.min(Math.max(c.jit(c.t.postOpenReloadMs * 1.5 ** n), c.t.minReloadMs), 15000);
}

/**
 * Заглушка «Almost there» и т.п. (§3.10, FLEET-SPEC §4.2):
 * refresh — после старта не реже раза в 4 с (очередь Apple пускает волнами), до старта — по фазам;
 * hold — заглушку с meta refresh не трогаем, без meta ждём holdBusyWaitSec и делаем один рефреш.
 */
export function busyBackoff(c: Ctl, page?: PageInfo): void {
  if (c.ts.mode === 'checkout') {
    const n = c.ts.busyInRow;
    const ms = busyMs(c);
    c.setState('BUSY', `заглушка Apple в чекауте (${n + 1}), рефреш через ${ms} мс`);
    c.scheduleReload(ms, 'busy-checkout');
    return;
  }
  const n = c.ts.busyInRow++;
  c.ts.busyHoldSince ??= Date.now();
  const plan = waitPlan(effectiveStrategy(c), phaseOf(c.cfg, c.os.openedAt), 'busy', {
    opened: !!c.os.openedAt, metaRefreshSec: page?.metaRefreshSec, busyInRow: n, waitedMs: Date.now() - c.ts.busyHoldSince,
  }, c.t);
  if (plan.fallback) { c.ts.busyHoldSince = undefined; c.ts.busyInRow = 0; c.log(plan.reason, 'warn'); }
  void c.save();
  if (plan.reload === null) {
    c.setState('BUSY', `заглушка Apple (${n + 1}) — ${plan.reason}`);
    // страница обновит себя сама; если meta refresh не сработал — пересчитать (без рефреша с нашей стороны)
    c.timer(((page?.metaRefreshSec ?? 60) + 10) * 1000, () => c.rerun('busy-meta-recheck'));
    return;
  }
  const ms = plan.reload === 0 ? 0 : Math.max(c.jit(plan.reload), c.t.minReloadMs);
  c.setState('BUSY', `заглушка Apple (${n + 1}) — ${plan.reason}${ms ? `, рефреш через ${(ms / 1000).toFixed(1)} с` : ''}`);
  c.scheduleReload(ms, 'busy');
}

/**
 * Страница очереди Apple (iPhone 18 Pro, 12.09.2026: «will open the order page when it has reached your spot
 * in the queue»). Рефреш может сбросить место — ждём, пока страница сама уйдёт дальше: refresh до queueMaxWaitSec,
 * hold до holdQueueWaitSec.
 */
export function queueStep(c: Ctl, page: PageInfo): void {
  c.ts.queueSince ??= Date.now();
  const plan = waitPlan(effectiveStrategy(c), phaseOf(c.cfg, c.os.openedAt), 'queue', {
    opened: !!c.os.openedAt, metaRefreshSec: page.metaRefreshSec, waitedMs: Date.now() - c.ts.queueSince,
  }, c.t);
  if (plan.fallback) {
    c.log(plan.reason, 'warn');
    c.ts.queueSince = undefined;
    c.setState('QUEUE', plan.reason);
    c.scheduleReload(0, 'queue-timeout');
    return;
  }
  const meta = page.metaRefreshSec;
  c.setState('QUEUE', `${plan.reason}${meta !== undefined ? ` (сама обновится через ${meta} с)` : ''}`);
  c.renderOverlay({ timerSince: c.ts.queueSince, timerLabel: 'в очереди' });
  c.timer(plan.reload ?? 1000, () => c.rerun('queue-timeout'));
}
