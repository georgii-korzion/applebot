// Разбор ответа fulfillment-messages (§3.0). Общий для наблюдателя во вкладке и страховочного поллера в SW.

export interface Buy { isBuyable: boolean; reason?: string; quote?: string }
export interface WatchResult { statuses: Record<string, Buy>; pickup: string; buyable: string[] }

export function fmUrl(base: string, parts: string[], store: string): string {
  const ps = parts.map((p, i) => `parts.${i}=${encodeURIComponent(p)}`).join('&');
  return `${base}/ae/shop/fulfillment-messages?fae=true&pl=true&mts.0=regular&mts.1=compact&${ps}&searchNearby=true&store=${store}`;
}

/** Разобрать JSON одного запроса (до 3 партов). */
export function parseFm(j: unknown, parts: string[], stores: string[]): { statuses: Record<string, Buy>; pick: string[] } {
  const root = j as { body?: { content?: unknown }; content?: unknown } | null;
  const content = (root?.body?.content ?? root?.content ?? {}) as {
    deliveryMessage?: Record<string, { compact?: { buyability?: Partial<Buy>; quote?: string }; regular?: { buyability?: Partial<Buy>; quote?: string } }>;
    pickupMessage?: { stores?: { storeNumber: string; partsAvailability?: Record<string, { pickupDisplay?: string }> }[] };
  };
  const statuses: Record<string, Buy> = {};
  const pick: string[] = [];
  for (const p of parts) {
    const dm = content.deliveryMessage?.[p] ?? {};
    const b = dm.compact?.buyability ?? dm.regular?.buyability ?? {};
    statuses[p] = {
      isBuyable: dm.compact?.buyability?.isBuyable === true || dm.regular?.buyability?.isBuyable === true,
      reason: b.reason,
      quote: dm.compact?.quote ?? dm.regular?.quote,
    };
  }
  for (const s of content.pickupMessage?.stores ?? []) {
    if (!stores.includes(s.storeNumber)) continue;
    for (const p of parts) {
      const pa = s.partsAvailability?.[p];
      if (pa) pick.push(`${s.storeNumber}:${p}=${pa.pickupDisplay}`);
    }
  }
  return { statuses, pick };
}

/** Опросить все targets (по 3 за запрос). Бросает при HTTP-ошибке или не-JSON (закрытый магазин). */
export async function pollFm(base: string, targets: string[], stores: string[], fetchFn: typeof fetch = fetch): Promise<WatchResult> {
  const statuses: Record<string, Buy> = {};
  const pick: string[] = [];
  const store = stores[0] ?? 'R597';
  for (let i = 0; i < targets.length; i += 3) {
    const chunk = targets.slice(i, i + 3);
    const r = await fetchFn(fmUrl(base, chunk, store), { credentials: 'include', cache: 'no-store', headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const one = parseFm(j, chunk, stores);
    Object.assign(statuses, one.statuses);
    pick.push(...one.pick);
  }
  const buyable = Object.entries(statuses).filter(([, s]) => s.isBuyable).map(([p]) => p);
  return { statuses, pickup: pick.join(' '), buyable };
}
