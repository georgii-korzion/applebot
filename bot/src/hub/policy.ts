// Чистые правила хаба (покрыты юнит-тестами): назначение заказов (§6), сторож зависаний (§10), адаптация H1 (§7).
import type { Strategy } from '../../../src/shared/bot';
import { WAIT_STATES } from '../config';

// ---------- назначение заказов (§6.3) ----------
export type OrderState = 'OPEN' | 'CLAIMED' | 'IN_BAG' | 'PAY_READY' | 'PLACED' | 'ORDERED' | 'NEED_HUMAN' | 'FAILED';

export interface OrderView { id: string; priority: number; state: OrderState; claimers: string[]; failed: string[] }

/** Самый приоритетный заказ, у которого меньше claimersPerOrder живых претендентов и который ещё не на оплате. */
export function pickOrder(orders: OrderView[], claimersPerOrder: number, browser: string, alive: (b: string) => boolean): OrderView | null {
  const open = orders
    .filter((o) => o.state === 'OPEN' || o.state === 'CLAIMED' || o.state === 'IN_BAG')
    .filter((o) => !o.failed.includes(browser))
    .filter((o) => o.claimers.filter((c) => c !== browser && alive(c)).length < claimersPerOrder)
    .sort((a, b) => a.priority - b.priority);
  return open[0] ?? null;
}

// ---------- сторож (§10) ----------
export function stuckThreshold(state: string, thresholds: Record<string, number>, payment: { threeDsSec: number; applePaySec: number }): number | null {
  if (WAIT_STATES.has(state)) return null;
  if (state === 'WAIT_3DS') return payment.threeDsSec + 15;
  if (state === 'WAIT_APPLEPAY') return payment.applePaySec + 15;
  return thresholds[state] ?? null;
}

export function isStuck(state: string, since: number, now: number, thresholds: Record<string, number>, payment: { threeDsSec: number; applePaySec: number }, stopBeforePay = false): boolean {
  if (stopBeforePay && state === 'REVIEW') return false;
  const th = stuckThreshold(state, thresholds, payment);
  return th !== null && now - since > th * 1000;
}

// ---------- адаптация H1 (§7) ----------
/** watcher — наблюдатель JSON: до открытия не перезагружается (ведёт себя как hold), его «пустили» стратегию не доказывает. */
export interface FleetView { id: string; strategy: Strategy; admittedAt?: number; admittedStrategy?: Strategy; watcher?: boolean }

export interface AdaptState { firstAdmittedAt?: number; step: 0 | 1 | 2; nextAt?: number; manual: boolean; winner?: Strategy }

export function newAdapt(): AdaptState {
  return { step: 0, manual: false };
}

/**
 * Через w1 с после первого ADMITTED сравнить, сколько пустило по стратегиям. Одна пустила ≥2, другая 0 —
 * половину отстающих (ещё не пущенных) перевести; ещё через w2 с при той же картине — остальных, кроме двух контрольных.
 * Картина неясна — проверять раз в w2 с.
 */
export function adaptTick(st: AdaptState, fleet: FleetView[], now: number, w1: number, w2: number): { switches: { id: string; to: Strategy }[]; reason: string } | null {
  if (st.manual || st.step >= 2) return null;
  const firstAdm = Math.min(...fleet.filter((b) => b.admittedAt).map((b) => b.admittedAt!));
  if (!Number.isFinite(firstAdm)) return null;
  st.firstAdmittedAt ??= firstAdm;
  st.nextAt ??= st.firstAdmittedAt + w1 * 1000;
  if (now < st.nextAt) return null;
  const adm = (s: Strategy, watchers: boolean) => fleet.filter((b) => b.admittedAt && (watchers || !b.watcher) && (b.admittedStrategy ?? b.strategy) === s).length;
  // наблюдатель до открытия стоит (как hold), а в момент OPEN перезагружается (как refresh): в общий счёт он идёт,
  // но сам по себе не перечёркивает победу другой стратегии
  const rAll = adm('refresh', true), hAll = adm('hold', true);
  const r = adm('refresh', false), h = adm('hold', false);
  const winner: Strategy | null = rAll >= 2 && r >= 1 && h === 0 ? 'refresh' : hAll >= 2 && h >= 1 && r === 0 ? 'hold' : null;
  st.nextAt = now + w2 * 1000;
  if (!winner || (st.winner && st.winner !== winner)) return null;
  const loser: Strategy = winner === 'refresh' ? 'hold' : 'refresh';
  const losers = fleet.filter((b) => !b.admittedAt && b.strategy === loser).sort((a, b) => a.id.localeCompare(b.id));
  if (!losers.length) { st.step = 2; return null; }
  let n: number;
  if (st.step === 0) { n = Math.ceil(losers.length / 2); st.step = 1; st.winner = winner; } else { n = Math.max(0, losers.length - 2); st.step = 2; }
  if (n <= 0) return null;
  return {
    switches: losers.slice(0, n).map((b) => ({ id: b.id, to: winner })),
    reason: `пущено: refresh ${rAll}, hold ${hAll} → ${n} браузер(а) ${loser} → ${winner}${st.step === 2 ? ' (кроме 2 контрольных)' : ''}`,
  };
}

// ---------- стратегии и прокси при запуске ----------
/** Раздать стратегии по долям так, чтобы и прямые, и прокси-браузеры были в обеих группах. */
export function assignStrategies(n: number, mix: { refresh: number; hold: number }, groups: number[][]): Strategy[] {
  const total = mix.refresh + mix.hold || 1;
  const holdN = Math.round((n * mix.hold) / total);
  const out: Strategy[] = Array(n).fill('refresh');
  let k = 0;
  // внутри каждой группы — через одного, пропорционально доле
  for (const g of groups) {
    const want = Math.round((g.length * mix.hold) / total);
    const picks = [...g.filter((_, i) => i % 2 === 1), ...g.filter((_, i) => i % 2 === 0)];
    for (const i of picks.slice(0, want)) { out[i] = 'hold'; k++; }
  }
  // округления: подогнать к общей доле
  const all = groups.flat();
  for (const i of all) { if (k >= holdN) break; if (out[i] === 'refresh') { out[i] = 'hold'; k++; } }
  for (const i of [...all].reverse()) { if (k <= holdN) break; if (out[i] === 'hold') { out[i] = 'refresh'; k--; } }
  return out;
}
