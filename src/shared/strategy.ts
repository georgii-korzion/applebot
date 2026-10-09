// Стратегии ожидания открытия (FLEET-SPEC §4.2): refresh — перезагружать по фазам, hold — ждать и опрашивать JSON.
// Чистая функция без DOM и таймеров: таблица §4.2 проверяется юнит-тестами построчно.
import type { Phase, Strategy, Timing } from './config';

/** Что видит вкладка: товар до старта («Continue»), заглушка нагрузки, очередь Apple, закрытый магазин/404/пустая. */
export type WaitKind = 'preorder' | 'busy' | 'queue' | 'closed';

export interface WaitCtx {
  /** Свой OPEN уже был (JSON сказал buyable) — после него стратегии не различаются. */
  opened?: boolean;
  /** `<meta http-equiv=refresh>` на странице (секунды) — страница обновит себя сама. */
  metaRefreshSec?: number;
  /** Сколько мс прошло с openAt (отрицательно — до старта). */
  sinceOpenAt?: number;
  /** Подряд заглушек (бэкофф refresh). */
  busyInRow?: number;
  /** Сколько мс уже ждём на этой странице (очередь / заглушка hold). */
  waitedMs?: number;
}

export interface WaitPlan {
  /** Через сколько мс перезагрузить (без джиттера); null — не трогать страницу. */
  reload: number | null;
  reason: string;
  /** hold исчерпал ожидание (holdFallbackSec / holdBusyWaitSec) — вызывающий переключает профиль на refresh / сбрасывает счётчик. */
  fallback?: boolean;
}

/** База рефреша по фазе для refresh (как closedReloadMs, но без джиттера). */
function phaseMs(phase: Phase, t: Timing): number {
  return { armed: t.closedReloadMs, pre: t.preOpenReloadMs, post: t.postOpenReloadMs }[phase];
}

export function waitPlan(strategy: Strategy, phase: Phase, kind: WaitKind, ctx: WaitCtx, t: Timing): WaitPlan {
  const opened = !!ctx.opened;
  const hold = strategy === 'hold' && !opened;
  switch (kind) {
    case 'preorder': {
      if (opened) return { reload: t.postOpenReloadMs, reason: 'OPEN был, формы покупки ещё нет — рефреш' };
      if (phase === 'armed') return { reload: null, reason: 'до openAt−60 с не рефрешим' };
      if (!hold) return { reload: phase === 'pre' ? t.preOpenReloadMs : t.postOpenReloadMs, reason: phase === 'pre' ? 'последняя минута — рефреш' : 'после openAt — рефреш' };
      if (phase === 'post' && (ctx.sinceOpenAt ?? 0) >= t.holdFallbackSec * 1000) {
        return { reload: t.postOpenReloadMs, reason: `hold не дождался OPEN за ${t.holdFallbackSec} с — перехожу на refresh`, fallback: true };
      }
      return { reload: null, reason: phase === 'pre' ? 'hold: последняя минута, только JSON' : 'hold: после openAt, только JSON' };
    }
    case 'busy': {
      const n = ctx.busyInRow ?? 0;
      if (hold) {
        if (ctx.metaRefreshSec !== undefined) return { reload: null, reason: `hold: заглушка обновится сама через ${ctx.metaRefreshSec} с — не трогаем` };
        const left = t.holdBusyWaitSec * 1000 - (ctx.waitedMs ?? 0);
        if (left <= 0) return { reload: 0, reason: `hold: заглушка без meta refresh ${t.holdBusyWaitSec} с — один рефреш`, fallback: true };
        return { reload: left, reason: `hold: заглушка без meta refresh — рефреш через ${Math.round(left / 1000)} с` };
      }
      const base = phaseMs(opened ? 'post' : phase, t);
      if (phase === 'post' || opened) {
        const ms = Math.min(Math.max(Math.round(base * 1.2 ** n), t.minReloadMs), 4000);
        if (ctx.metaRefreshSec !== undefined && ctx.metaRefreshSec <= 60) return { reload: Math.max((ctx.metaRefreshSec + 5) * 1000, ms), reason: 'заглушка обновится сама — наш рефреш только страховка' };
        return { reload: ms, reason: `заглушка (${n + 1}), бэкофф ≤ 4 с` };
      }
      if (ctx.metaRefreshSec !== undefined && ctx.metaRefreshSec <= 60) return { reload: Math.max((ctx.metaRefreshSec + 5) * 1000, base), reason: 'заглушка обновится сама — наш рефреш только страховка' };
      return { reload: base, reason: `заглушка (${n + 1}), рефреш по фазе` };
    }
    case 'queue': {
      const limit = (hold ? t.holdQueueWaitSec : t.queueMaxWaitSec) * 1000;
      const left = limit - (ctx.waitedMs ?? 0);
      if (left <= 0) return { reload: 0, reason: `очередь не пустила за ${Math.round(limit / 1000)} с — рефреш`, fallback: true };
      return { reload: left, reason: `очередь Apple — не трогаем ещё ${Math.round(left / 1000)} с${hold ? ' (hold)' : ''}` };
    }
    case 'closed': {
      if (opened) return { reload: t.postOpenReloadMs, reason: 'OPEN был, магазин/страница закрыты — рефреш' };
      if (hold) return { reload: t.closedReloadMs, reason: `hold: закрыто — рефреш раз в ${Math.round(t.closedReloadMs / 1000)} с независимо от фазы` };
      return { reload: phaseMs(phase, t), reason: `закрыто — рефреш по фазе (${phase})` };
    }
  }
}
