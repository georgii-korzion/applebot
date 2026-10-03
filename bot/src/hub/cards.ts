// Пул карт (BOT-SPEC §9.3): раздача заказам (primary по кругу с учётом maxOrders, reserve — только на замену),
// отказ → BURNED, исчерпание, ворота Place Order (не больше parallelPerCard ожидающих подтверждения на карту).
import type { CardDef } from '../config';

export type CardStatus = 'ACTIVE' | 'EXHAUSTED' | 'BURNED';

export interface CardState {
  id: string;
  label: string;
  role: 'primary' | 'reserve';
  last4: string;
  maxOrders: number;
  status: CardStatus;
  /** Заказы, закреплённые за картой (назначенные и оплаченные). */
  orders: string[];
  paid: string[];
  declines: number;
}

export interface PlaceGrant { cardId: string; browser: string; orderId: string; at: number; placed: boolean }

export class CardPool {
  cards: CardState[];
  /** Выданные PLACE_TURN / нажатые Place Order, ждущие исхода (банк). */
  pending: PlaceGrant[] = [];
  /** Очередь PLACE_REQ по картам. */
  queue: { cardId: string; browser: string; orderId: string; at: number }[] = [];

  constructor(defs: CardDef[], saved?: Partial<CardState>[], private parallelPerCard = 1, private burnAfter = 1) {
    this.cards = defs.map((d) => {
      const s = saved?.find((x) => x.id === d.id);
      return {
        id: d.id, label: d.label, role: d.role, last4: d.number.slice(-4), maxOrders: d.maxOrders,
        status: (s?.status as CardStatus) ?? 'ACTIVE', orders: s?.orders ?? [], paid: s?.paid ?? [], declines: s?.declines ?? 0,
      };
    });
  }

  get(id: string | null | undefined): CardState | undefined {
    return id ? this.cards.find((c) => c.id === id) : undefined;
  }

  forOrder(orderId: string): CardState | undefined {
    return this.cards.find((c) => c.orders.includes(orderId) && !c.paid.includes(orderId) && c.status === 'ACTIVE')
      ?? this.cards.find((c) => c.orders.includes(orderId) && c.status !== 'BURNED');
  }

  private free(c: CardState): boolean {
    return c.status === 'ACTIVE' && c.orders.length < c.maxOrders;
  }

  /** Карта для заказа при ASSIGN: уже закреплённая или primary с наименьшей загрузкой (по кругу). */
  assign(orderId: string): CardState | null {
    const have = this.cards.find((c) => c.orders.includes(orderId) && c.status === 'ACTIVE');
    if (have) return have;
    const cand = this.cards.filter((c) => c.role === 'primary' && this.free(c));
    if (!cand.length) return null;
    const best = cand.reduce((a, c) => (c.orders.length < a.orders.length ? c : a), cand[0]);
    best.orders.push(orderId);
    return best;
  }

  /** Замена сгоревшей: только reserve (§9.3 п. 3). */
  replacement(orderId: string): CardState | null {
    const r = this.cards.find((c) => c.role === 'reserve' && this.free(c));
    if (!r) return null;
    this.release(orderId);
    r.orders.push(orderId);
    return r;
  }

  /** Любая свободная карта (Apple Pay недоступен на Billing, §9). */
  anyFree(orderId: string): CardState | null {
    const c = this.cards.find((x) => x.role === 'primary' && this.free(x)) ?? this.cards.find((x) => this.free(x));
    if (!c) return null;
    this.release(orderId);
    c.orders.push(orderId);
    return c;
  }

  /** Ручная привязка (/card b07 c3). */
  set(orderId: string, cardId: string): CardState | null {
    const c = this.get(cardId);
    if (!c || c.status !== 'ACTIVE') return null;
    this.release(orderId);
    if (!c.orders.includes(orderId)) c.orders.push(orderId);
    return c;
  }

  /** Заказ ушёл с карты (Apple Pay, замена) — место освобождается, если заказ не оплачен ею. */
  release(orderId: string): void {
    for (const c of this.cards) if (!c.paid.includes(orderId)) c.orders = c.orders.filter((o) => o !== orderId);
  }

  /** Заказ оплачен картой. Возвращает, кому дать ход по этой карте следующим. */
  markPaid(cardId: string, orderId: string): { browser: string; orderId: string } | null {
    const c = this.get(cardId);
    if (!c) return null;
    if (!c.paid.includes(orderId)) c.paid.push(orderId);
    if (!c.orders.includes(orderId)) c.orders.push(orderId);
    if (c.paid.length >= c.maxOrders && c.status === 'ACTIVE') c.status = 'EXHAUSTED';
    return this.settle(cardId, orderId);
  }

  /** Явный отказ: burned — карта сгорела (burnAfterDeclines); next — кому дать ход, если не сгорела. */
  decline(cardId: string, orderId: string): { burned: boolean; next: { browser: string; orderId: string } | null } {
    const c = this.get(cardId);
    if (!c) return { burned: false, next: null };
    c.declines++;
    const burned = c.declines >= this.burnAfter && c.status !== 'BURNED';
    if (burned) c.status = 'BURNED';
    const next = this.settle(cardId, orderId);
    return { burned, next };
  }

  unburn(cardId: string): boolean {
    const c = this.get(cardId);
    if (!c || c.status !== 'BURNED') return false;
    c.declines = 0;
    c.status = c.paid.length >= c.maxOrders ? 'EXHAUSTED' : 'ACTIVE';
    return true;
  }

  exhausted(): boolean {
    return !this.cards.some((c) => c.role === 'reserve' && this.free(c));
  }

  // ---------- ворота Place Order (§9.1 п. 3) ----------
  /** PLACE_REQ: 'granted' — можно жать; 'queued' — ждать; 'burned' — карта сгорела (нужна замена). */
  requestPlace(cardId: string, browser: string, orderId: string, now = Date.now()): 'granted' | 'queued' | 'burned' {
    const c = this.get(cardId);
    if (!c || c.status === 'BURNED') return 'burned';
    if (this.pending.some((p) => p.cardId === cardId && p.browser === browser)) return 'granted';
    const busy = this.pending.filter((p) => p.cardId === cardId).length;
    if (busy < this.parallelPerCard && !this.queue.some((q) => q.cardId === cardId && q.browser !== browser)) {
      this.queue = this.queue.filter((q) => q.browser !== browser);
      this.pending.push({ cardId, browser, orderId, at: now, placed: false });
      return 'granted';
    }
    if (!this.queue.some((q) => q.browser === browser)) this.queue.push({ cardId, browser, orderId, at: now });
    return 'queued';
  }

  placed(cardId: string, browser: string, orderId: string, now = Date.now()): void {
    const p = this.pending.find((x) => x.cardId === cardId && x.browser === browser);
    if (p) p.placed = true;
    else this.pending.push({ cardId, browser, orderId, at: now, placed: true });
  }

  /** Исход по карте известен (заказ, отказ, человек) — освободить место; вернуть, кому дать ход следующим. */
  settle(cardId: string, orderId: string): { browser: string; orderId: string } | null {
    this.pending = this.pending.filter((p) => !(p.cardId === cardId && p.orderId === orderId));
    return this.nextGrant(cardId);
  }

  settleBrowser(browser: string): { browser: string; orderId: string; cardId: string }[] {
    const cards = new Set(this.pending.filter((p) => p.browser === browser).map((p) => p.cardId));
    this.pending = this.pending.filter((p) => p.browser !== browser);
    this.queue = this.queue.filter((q) => q.browser !== browser);
    const out: { browser: string; orderId: string; cardId: string }[] = [];
    for (const id of cards) { const g = this.nextGrant(id); if (g) out.push({ ...g, cardId: id }); }
    return out;
  }

  /** Выданный ход без нажатия дольше ms — забрать (браузер упал/перезагрузился). */
  expireGrants(ms: number, now = Date.now()): { browser: string; orderId: string; cardId: string }[] {
    const stale = this.pending.filter((p) => !p.placed && now - p.at > ms);
    const out: { browser: string; orderId: string; cardId: string }[] = [];
    for (const p of stale) {
      this.pending = this.pending.filter((x) => x !== p);
      const g = this.nextGrant(p.cardId);
      if (g) out.push({ ...g, cardId: p.cardId });
    }
    return out;
  }

  private nextGrant(cardId: string): { browser: string; orderId: string } | null {
    const c = this.get(cardId);
    if (!c || c.status === 'BURNED') return null;
    if (this.pending.filter((p) => p.cardId === cardId).length >= this.parallelPerCard) return null;
    const i = this.queue.findIndex((q) => q.cardId === cardId);
    if (i < 0) return null;
    const [q] = this.queue.splice(i, 1);
    this.pending.push({ cardId, browser: q.browser, orderId: q.orderId, at: Date.now(), placed: false });
    return { browser: q.browser, orderId: q.orderId };
  }

  /** Убрать из очереди запросы по карте (сгорела) — вернуть, кто ждал. */
  dropQueue(cardId: string): { browser: string; orderId: string }[] {
    const out = this.queue.filter((q) => q.cardId === cardId).map((q) => ({ browser: q.browser, orderId: q.orderId }));
    this.queue = this.queue.filter((q) => q.cardId !== cardId);
    return out;
  }

  snapshot(): Partial<CardState>[] {
    return this.cards.map((c) => ({ id: c.id, status: c.status, orders: c.orders, paid: c.paid, declines: c.declines }));
  }
}
