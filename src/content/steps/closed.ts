// Магазин закрыт перед дропом («We'll be back»), пустая страница, 404 или редирект вместо товара.
// Вкладка не уходит и не «долбит» сайт: рефрешит цель по фазам (refresh) или раз в closedReloadMs (hold),
// пока Apple не пустит на покупку (FLEET-SPEC §4.2).
import { phaseOf } from '../../shared/config';
import { waitPlan } from '../../shared/strategy';
import type { Ctl } from '../ctl';
import type { PageInfo } from '../classify';
import { ensureWatcher, watcherHolds } from './preopen';
import { effectiveStrategy } from './common';

const PHASE_LABEL = { armed: 'до старта', pre: 'последняя минута', post: 'после старта' } as const;

/** Сообщить SW, закрыт ли магазин (SW уведомит при закрытии/открытии). */
export function reportStore(c: Ctl, closed: boolean, reason: string): void {
  if (!!c.ts.storeClosed === closed && (closed || !c.os.storeClosedSince)) return;
  c.ts.storeClosed = closed;
  void c.save();
  c.send({ t: 'STORE', closed, reason });
}

function onTargetPage(c: Ctl): boolean {
  try {
    return new URL(c.targetUrl()).pathname.toLowerCase() === location.pathname.replace(/\/$/, '').toLowerCase();
  } catch {
    return false;
  }
}

export function closedStep(c: Ctl, page: PageInfo, reason: string): void {
  reportStore(c, true, reason);
  ensureWatcher(c);
  const now = Date.now();
  const openAt = Date.parse(c.cfg.openAt);
  const phase = phaseOf(c.cfg, c.os.openedAt, now);
  const untilPre = openAt - 60_000 - now;
  const untilOpen = openAt - now;

  // наблюдатель до openAt не рефрешит: он опрашивает JSON и первым увидит открытие
  if (c.ts.mode === 'race' && watcherHolds(c) && phase !== 'post') {
    c.setState('CLOSED', `${reason} — наблюдатель опрашивает JSON, рефреш со старта`);
    c.renderOverlay({ countdownTo: openAt });
    c.timer(Math.min(untilOpen, 3_600_000), () => c.rerun('closed:open'));
    return;
  }

  const strategy = c.ts.mode === 'race' ? effectiveStrategy(c) : 'refresh';
  const plan = waitPlan(strategy, phase, 'closed', { opened: !!c.os.openedAt }, c.t);
  let ms = Math.max(c.jit(plan.reload ?? c.t.closedReloadMs), c.t.minReloadMs);
  if (c.ts.mode === 'checkout') ms = Math.max(ms, 5000); // закрытие посреди чекаута (ночные работы) — спокойнее
  // не проспать смену фазы (refresh)
  if (strategy === 'refresh') {
    if (phase === 'armed' && untilPre > 0) ms = Math.min(ms, Math.max(untilPre, c.t.minReloadMs));
    if (phase === 'pre' && untilOpen > 0) ms = Math.min(ms, Math.max(untilOpen, c.t.minReloadMs));
  }

  const back = c.ts.mode === 'race' && !onTargetPage(c);
  c.setState('CLOSED', `${reason} — ${back ? 'назад к цели' : 'рефреш'} через ${(ms / 1000).toFixed(1)} с (${strategy === 'hold' ? 'hold' : PHASE_LABEL[phase]})`);
  c.renderOverlay(phase === 'post' ? { countdownTo: undefined } : { countdownTo: openAt });
  c.timer(ms, () => {
    if (back) void c.navigate(c.targetUrl(), `закрыто (${page.kind}) → цель`, true);
    else void c.reload('closed');
  });
}
