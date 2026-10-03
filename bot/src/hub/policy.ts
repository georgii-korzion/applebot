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
export interface FleetView { id: string; strategy: Strategy; admittedAt?: number; admittedStrategy?: Strategy }

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
  const adm = (s: Strategy) => fleet.filter((b) => b.admittedAt && (b.admittedStrategy ?? b.strategy) === s).length;
  const r = adm('refresh'), h = adm('hold');
  const winner: Strategy | null = r >= 2 && h === 0 ? 'refresh' : h >= 2 && r === 0 ? 'hold' : null;
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
    reason: `пущено: refresh ${r}, hold ${h} → ${n} браузер(а) ${loser} → ${winner}${st.step === 2 ? ' (кроме 2 контрольных)' : ''}`,
  };
}

// ---------- стратегии и прокси при запуске ----------
/** Раздать стратегии по долям так, чтобы и прямые, и прокси-браузеры были в обеих группах. */
export function assignStrategies(n: number, mix: { refresh: number; hold: number }, groups: number[][]): Strategy[] {
  const total = mix.refresh + mix.hold || 1;
  const holdN = Math.round((n * mix.hold) / total);
  const out: Strategy[] = Array(n).fill('refresh');
  // по очереди из каждой группы (прямые / прокси), чтобы hold достался обеим
  const order: number[] = [];
  const g = groups.map((x) => [...x]);
  while (g.some((x) => x.length)) for (const x of g) { const v = x.shift(); if (v !== undefined) order.push(v); }
  let k = 0;
  for (let i = 1; i < order.length && k < holdN; i += 2, k++) out[order[i]] = 'hold';
  for (let i = 0; i < order.length && k < holdN; i += 2) if (out[order[i]] !== 'hold') { out[order[i]] = 'hold'; k++; }
  return out;
}
