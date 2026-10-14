// Разбор ответа fulfillment-messages (§3.0) и сигнал OPEN. Общий для наблюдателя во вкладке и страховочного поллера в SW.
import type { OpenSignal, Phase } from './config';

export interface Buy { isBuyable: boolean; reason?: string; quote?: string }
export interface WatchResult {
  statuses: Record<string, Buy>;
  /** Самовывоз по магазинам из конфига: «R597:MJR54AH/A=available …» (для лога и дашборда). */
  pickup: string;
  /** Парты с isBuyable (доставка). */
  buyable: string[];
  /** Парты, у которых pickupDisplay=available хотя бы в одном магазине из конфига. */
  pickupParts: string[];
}

export function fmUrl(base: string, parts: string[], store: string): string {
  const ps = parts.map((p, i) => `parts.${i}=${encodeURIComponent(p)}`).join('&');
  return `${base}/ae/shop/fulfillment-messages?fae=true&pl=true&mts.0=regular&mts.1=compact&${ps}&searchNearby=true&store=${store}`;
}

/** Разобрать JSON одного запроса (до 3 партов). */
export function parseFm(j: unknown, parts: string[], stores: string[]): { statuses: Record<string, Buy>; pick: string[]; pickupParts: string[] } {
  const root = j as { body?: { content?: unknown }; content?: unknown } | null;
  const content = (root?.body?.content ?? root?.content ?? {}) as {
    deliveryMessage?: Record<string, { compact?: { buyability?: Partial<Buy>; quote?: string }; regular?: { buyability?: Partial<Buy>; quote?: string } }>;
    pickupMessage?: { stores?: { storeNumber: string; partsAvailability?: Record<string, { pickupDisplay?: string }> }[] };
  };
  const statuses: Record<string, Buy> = {};
  const pick: string[] = [];
  const pickupParts: string[] = [];
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
      if (!pa) continue;
      pick.push(`${s.storeNumber}:${p}=${pa.pickupDisplay}`);
      if (String(pa.pickupDisplay).toLowerCase() === 'available' && !pickupParts.includes(p)) pickupParts.push(p);
    }
  }
  return { statuses, pick, pickupParts };
}

export interface FoundStore { id: string; name: string; city: string }

/** Магазины из ответа fulfillment-messages (searchNearby): код, название, город — для «Найти магазины» в настройках. */
export function parseStores(j: unknown): FoundStore[] {
  const root = j as { body?: { content?: unknown }; content?: unknown } | null;
  const content = (root?.body?.content ?? root?.content ?? {}) as { pickupMessage?: { stores?: Record<string, any>[] } };
  const out: FoundStore[] = [];
  for (const s of content.pickupMessage?.stores ?? []) {
    const id = String(s?.storeNumber ?? '').toUpperCase();
    if (!/^R\d{3,4}$/.test(id) || out.some((x) => x.id === id)) continue;
    const name = String(s.storeName ?? s.retailStore?.name ?? s.storeDisplayName ?? '').trim();
    const city = String(s.city ?? s.address?.city ?? s.retailStore?.address?.city ?? s.storeCity ?? '').trim();
    out.push({ id, name: name ? (/^Apple /.test(name) ? name : `Apple ${name}`) : id, city });
  }
  return out;
}

/** Опросить все targets (по 3 за запрос). Бросает при HTTP-ошибке или не-JSON (закрытый магазин). */
export async function pollFm(base: string, targets: string[], stores: string[], fetchFn: typeof fetch = fetch): Promise<WatchResult> {
  const statuses: Record<string, Buy> = {};
  const pick: string[] = [];
  const pickupParts: string[] = [];
  const store = stores[0] ?? 'R597';
  for (let i = 0; i < targets.length; i += 3) {
    const chunk = targets.slice(i, i + 3);
    const r = await fetchFn(fmUrl(base, chunk, store), { credentials: 'include', cache: 'no-store', headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const one = parseFm(j, chunk, stores);
    Object.assign(statuses, one.statuses);
    pick.push(...one.pick);
    for (const p of one.pickupParts) if (!pickupParts.includes(p)) pickupParts.push(p);
  }
  const buyable = Object.entries(statuses).filter(([, s]) => s.isBuyable).map(([p]) => p);
  return { statuses, pickup: pick.join(' '), buyable, pickupParts };
}

/**
 * Парты, по которым сигнал OPEN выполнен (FLEET-SPEC §3.0, 16.10: товар уже в продаже, дроп — квота самовывоза):
 * pickup — самовывоз доступен в одном из магазинов конфига; delivery — isBuyable (старое поведение); any — любое из двух.
 * Порядок — как в targets.
 */
export function openParts(r: Pick<WatchResult, 'buyable' | 'pickupParts'>, signal: OpenSignal, targets: string[]): string[] {
  const ok = (p: string) => (signal === 'pickup' ? r.pickupParts.includes(p)
    : signal === 'delivery' ? r.buyable.includes(p)
      : r.pickupParts.includes(p) || r.buyable.includes(p));
  return targets.filter(ok);
}

/**
 * Можно ли по сигналу объявлять OPEN (§7.3): до openAt−60 с — никогда (товар может быть в продаже задолго до дропа,
 * как 18 Pro перед 16.10); в последнюю минуту — только по фронту «не было → появилось» (если доступно было и раньше,
 * это не открытие дропа); после openAt — пока сигнал есть. prev — результат прошлого опроса того же источника.
 */
export function openEdge(prev: boolean | undefined, open: boolean, phase: Phase): boolean {
  if (phase === 'post') return open;
  if (phase === 'pre') return open && prev === false;
  return false;
}
