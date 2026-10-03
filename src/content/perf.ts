// Разбивка времени шага (BOT-SPEC §20, `bot bench`): сеть / ожидание элемента / пауза в коде.
// Считается только «верхнее» ожидание: вложенные ожидания внутри уже идущего не учитываются второй раз.

export type PerfCat = 'net' | 'wait' | 'pause';
export const perf = { net: 0, wait: 0, pause: 0 };
let active: PerfCat | null = null;

export function track<T>(cat: PerfCat, make: () => Promise<T>): Promise<T> {
  if (active) return make();
  active = cat;
  const t0 = performance.now();
  let p: Promise<T>;
  try {
    p = make();
  } catch (e) {
    active = null;
    throw e;
  }
  const done = () => { perf[cat] += performance.now() - t0; if (active === cat) active = null; };
  p.then(done, done);
  return p;
}

export function resetPerf(from?: { net: number; wait: number; pause: number }): void {
  perf.net = from?.net ?? 0;
  perf.wait = from?.wait ?? 0;
  perf.pause = from?.pause ?? 0;
}

/** Загрузка страницы целиком (до DOMContentLoaded) — это сеть. */
export function addNavigation(): void {
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  if (!nav) return;
  perf.net += nav.domContentLoadedEventEnd > 0 ? nav.domContentLoadedEventEnd : nav.responseEnd;
}
