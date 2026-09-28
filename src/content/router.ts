// Отслеживание смены URL без перезагрузки (одностраничный чекаут, §8.3).
// pushState не даёт событий в изолированном мире — опрос location.href раз в 150 мс.

export function routeKey(href: string): string {
  const u = new URL(href);
  // «Fulfillment-init» и «Fulfillment» — один шаг: не прерывать идущий шаг из-за смены суффикса
  const s = (u.searchParams.get('_s') ?? '').replace(/-init$/i, '').toLowerCase();
  return `${u.pathname}|${s}|${u.searchParams.get('step') ?? ''}`;
}

export function watchRoute(onChange: (href: string, prev: string) => void): () => void {
  let prevHref = location.href;
  let prevKey = routeKey(prevHref);
  const iv = setInterval(() => {
    const href = location.href;
    if (href === prevHref) return;
    const key = routeKey(href);
    const old = prevHref;
    prevHref = href;
    if (key !== prevKey) {
      prevKey = key;
      onChange(href, old);
    }
  }, 150);
  return () => clearInterval(iv);
}
