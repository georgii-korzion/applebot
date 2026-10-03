// Очередь внимания человека (BOT-SPEC §10): человек один, окон много — вперёд по одному окну.
// Приоритет: 3-D Secure с вводом → QR Apple Pay → NEED_HUMAN на оплате → капча → ассистент Add to Bag → остальное.
import { HUMAN_PRIORITY, type HumanReason } from '../../../src/shared/bot';

export interface AttnItem {
  browser: string;
  reason: HumanReason;
  priority: number;
  since: number;
  text: string;
  orderId: string | null;
  /** Состояние браузера в момент добавления: смена состояния = человек разобрался. */
  state: string;
  skipped?: number;
}

export class AttentionQueue {
  items: AttnItem[] = [];
  active: AttnItem | null = null;
  activeSince = 0;

  add(it: Omit<AttnItem, 'priority' | 'since'> & { since?: number }): AttnItem {
    const ex = this.items.find((x) => x.browser === it.browser && x.reason === it.reason);
    if (ex) { ex.text = it.text; ex.state = it.state; ex.orderId = it.orderId; return ex; }
    const item: AttnItem = { ...it, priority: HUMAN_PRIORITY[it.reason] ?? 7, since: it.since ?? Date.now() };
    this.items.push(item);
    return item;
  }

  has(browser: string, reason?: HumanReason): boolean {
    return this.items.some((x) => x.browser === browser && (!reason || x.reason === reason));
  }

  /** Убрать поводы браузера (все или одну причину). true — снят активный. */
  resolve(browser: string, reason?: HumanReason): boolean {
    this.items = this.items.filter((x) => !(x.browser === browser && (!reason || x.reason === reason)));
    if (this.active && this.active.browser === browser && (!reason || this.active.reason === reason)) {
      this.active = null;
      return true;
    }
    return false;
  }

  /** Следующее окно: наивысший приоритет, затем самое старое; пропущенные «Дальше» — в конце. */
  next(now = Date.now()): AttnItem | null {
    if (this.active && this.items.includes(this.active)) return null;
    const sorted = [...this.items].sort((a, b) => (a.skipped ?? 0) - (b.skipped ?? 0) || a.priority - b.priority || a.since - b.since);
    this.active = sorted[0] ?? null;
    this.activeSince = this.active ? now : 0;
    return this.active;
  }

  /** «Дальше» / /next: текущее окно в конец очереди. */
  skip(): AttnItem | null {
    if (this.active) this.active.skipped = (this.active.skipped ?? 0) + 1;
    this.active = null;
    return this.next();
  }
}
