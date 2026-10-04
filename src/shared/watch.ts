// Разбор ответа fulfillment-messages (§3.0). Общий для наблюдателя во вкладке и страховочного поллера в SW.

export interface Buy { isBuyable: boolean; reason?: string; quote?: string }
/** Самовывоз есть: магазин и парт (pickupDisplay = available). */
export interface StockHit { store: string; part: string }
export interface WatchResult { statuses: Record<string, Buy>; pickup: string; buyable: string[]; stock: StockHit[] }

export function fmUrl(base: string, parts: string[], store: string): string {
  const ps = parts.map((p, i) => `parts.${i}=${encodeURIComponent(p)}`).join('&');
  return `${base}/ae/shop/fulfillment-messages?fae=true&pl=true&mts.0=regular&mts.1=compact&${ps}&searchNearby=true&store=${store}`;
}

/** Разобрать JSON одного запроса (до 3 партов). */
export function parseFm(j: unknown, parts: string[], stores: string[]): { statuses: Record<string, Buy>; pick: string[]; stock: StockHit[] } {
  const root = j as { body?: { content?: unknown }; content?: unknown } | null;
  const content = (root?.body?.content ?? root?.content ?? {}) as {
    deliveryMessage?: Record<string, { compact?: { buyability?: Partial<Buy>; quote?: string }; regular?: { buyability?: Partial<Buy>; quote?: string } }>;
    pickupMessage?: { stores?: { storeNumber: string; partsAvailability?: Record<string, { pickupDisplay?: string }> }[] };
  };
  const statuses: Record<string, Buy> = {};
  const pick: string[] = [];
  const stock: StockHit[] = [];
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
      if (pa?.pickupDisplay === 'available') stock.push({ store: s.storeNumber, part: p });
    }
  }
  return { statuses, pick, stock };
}

/** Опросить все targets (по 3 за запрос). Бросает при HTTP-ошибке или не-JSON (закрытый магазин). */
export async function pollFm(base: string, targets: string[], stores: string[], fetchFn: typeof fetch = fetch): Promise<WatchResult> {
  const statuses: Record<string, Buy> = {};
  const pick: string[] = [];
  const stock: StockHit[] = [];
  const store = stores[0] ?? 'R597';
  for (let i = 0; i < targets.length; i += 3) {
    const chunk = targets.slice(i, i + 3);
    const r = await fetchFn(fmUrl(base, chunk, store), { credentials: 'include', cache: 'no-store', headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const one = parseFm(j, chunk, stores);
    Object.assign(statuses, one.statuses);
    pick.push(...one.pick);
    stock.push(...one.stock);
  }
  const buyable = Object.entries(statuses).filter(([, s]) => s.isBuyable).map(([p]) => p);
  return { statuses, pickup: pick.join(' '), buyable, stock };
}

/** Режим stock: парты с самовывозом в порядке приоритета targets — это и есть «buyable» для OPEN. */
export function stockParts(stock: StockHit[], targets: string[]): string[] {
  const have = new Set(stock.map((h) => h.part));
  return targets.filter((p) => have.has(p));
}
