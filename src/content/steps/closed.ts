// Магазин закрыт перед дропом («We'll be back»), пустая страница, 404 или редирект вместо товара.
// Вкладка не уходит и не «долбит» сайт: рефрешит цель по фазам, пока Apple не пустит на покупку.
//   до openAt−60 с — раз в closedReloadMs (30 с), последняя минута — preOpenReloadMs (3 с),
//   с openAt — postOpenReloadMs (1,5 с) сразу, без ожидания graceSec.
import { closedReloadMs, phaseOf } from '../../shared/config';
import type { Ctl } from '../ctl';
import type { PageInfo } from '../classify';
import { ensureWatcher } from './preopen';
import { holdStep, holdUntil, isStub } from './bot';
import { offTarget } from './common';

const PHASE_LABEL = { armed: 'до старта', pre: 'последняя минута', post: 'после старта' } as const;

/** Сообщить SW, закрыт ли магазин (SW уведомит при закрытии/открытии). */
export function reportStore(c: Ctl, closed: boolean, reason: string): void {
  if (!!c.ts.storeClosed === closed && (closed || !c.os.storeClosedSince)) return;
  c.ts.storeClosed = closed;
  void c.save();
  c.send({ t: 'STORE', closed, reason });
}


export function closedStep(c: Ctl, page: PageInfo, reason: string): void {
  reportStore(c, true, reason);
  ensureWatcher(c);
  const hold = c.ts.mode === 'race' && isStub(page.kind) ? holdUntil(c) : null;
  if (hold) { holdStep(c, page, reason, hold); return; }
  const now = Date.now();
  const openAt = Date.parse(c.cfg.openAt);
  const phase = phaseOf(c.cfg, c.os.openedAt, now);
  const untilPre = openAt - 60_000 - now;
  const untilOpen = openAt - now;

  // наблюдатель до openAt не рефрешит: он опрашивает JSON и первым увидит открытие
  if (c.ts.mode === 'race' && c.role === 'watcher' && phase !== 'post') {
    c.setState('CLOSED', `${reason} — наблюдатель опрашивает JSON, рефреш со старта`);
    c.renderOverlay({ countdownTo: openAt });
    c.timer(Math.min(untilOpen, 3_600_000), () => c.rerun('closed:open'));
    return;
  }

  let ms = closedReloadMs(c.cfg, c.os.openedAt, now);
  if (c.ts.mode === 'checkout') ms = Math.max(ms, 5000); // закрытие посреди чекаута (ночные работы) — спокойнее
  // не проспать смену фазы
  if (phase === 'armed' && untilPre > 0) ms = Math.min(ms, Math.max(untilPre, c.t.minReloadMs));
  if (phase === 'pre' && untilOpen > 0) ms = Math.min(ms, Math.max(untilOpen, c.t.minReloadMs));

  // не на чистом адресе цели (другой путь или хвост ?…&step=… после Add to Bag) — вернуться, а не рефрешить ту же 404
  const back = offTarget(c);
  c.setState('CLOSED', `${reason} — ${back ? 'назад к цели' : 'рефреш'} через ${(ms / 1000).toFixed(1)} с (${PHASE_LABEL[phase]})`);
  c.renderOverlay(phase === 'post' ? { countdownTo: undefined } : { countdownTo: openAt });
  c.timer(ms, () => {
    if (back) void c.navigate(c.targetUrl(), `закрыто (${page.kind}) → цель`, true);
    else void c.reload('closed');
  });
}
