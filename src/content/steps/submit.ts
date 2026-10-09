// Нажать Continue на шаге чекаута и понять, чем кончилось: переход на следующий шаг или ошибка.
// Сигналы «запрос завершён»: смена URL, завершение XHR checkoutx (PerformanceObserver), цикл
// disabled→enabled у кнопки, новый текст ошибки. Нужен именно «запрос завершён», а не «появился текст»:
// React не трогает DOM, если Apple второй раз показывает ту же ошибку («no longer available» два окна подряд).
import { SEL } from '../../shared/selectors';
import type { Ctl } from '../ctl';
import { clickEl, errorContext, isEnabled, raceFirst, sleep, waitForResource, waitForUrl, waitUntil } from '../dom';

export interface SubmitResult { result: 'next' | 'error' | 'timeout'; text: string; generic: boolean }

const CHECKOUTX = /\/shop\/checkoutx/;

function errorSnapshot(re: RegExp): string {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  return ((document.body?.innerText ?? '').match(g) ?? []).join('|');
}

/** Кнопка ушла в disabled (запрос пошёл) и вернулась (запрос завершён). */
function waitForButtonCycle(btn: Element, timeout: number, signal?: AbortSignal): Promise<true | null> {
  return waitUntil(() => (!isEnabled(btn) ? true : null), Math.min(timeout, 3000), signal)
    .then((went) => (went ? waitUntil(() => (isEnabled(btn) ? true : null), timeout, signal) : null));
}

export async function submitAndWait(c: Ctl, btn: Element, nextUrl: RegExp, errorRe: RegExp, timeout = c.t.continueWaitMs): Promise<SubmitResult> {
  const sig = c.signal;
  const t0 = performance.now();
  const before = errorSnapshot(errorRe);
  clickEl(btn);
  const r = await raceFirst([
    ['next', waitForUrl(nextUrl, timeout, sig)],
    ['error', waitUntil(() => { const s = errorSnapshot(errorRe); return s && s !== before ? s : null; }, timeout, sig)],
    ['done', waitForResource(CHECKOUTX, t0, timeout, sig).then((ok) => (ok ? sleep(400, sig).then(() => true) : null))],
    ['cycle', waitForButtonCycle(btn, timeout, sig).then((ok) => (ok ? sleep(250, sig).then(() => true) : null))],
  ], timeout, sig);
  if (r.key === 'next' || nextUrl.test(location.href)) return { result: 'next', text: '', generic: false };
  if (r.key === 'timeout') return { result: 'timeout', text: 'нет ответа', generic: true };
  // запрос завершился, но шаг не сменился — даём React дорисовать и читаем ошибку как есть (даже если текст тот же)
  if (r.key !== 'error' && (await waitForUrl(nextUrl, 1500, sig))) return { result: 'next', text: '', generic: false };
  const text = errorContext(errorRe) || (r.key === 'error' ? String(r.value).split('|').pop() ?? '' : '') || 'ошибка без текста';
  const generic = SEL.txtGenericError.test(text) && !SEL.txtSlotError.test(text) && !SEL.txtValidation.test(text);
  return { result: 'error', text, generic };
}
