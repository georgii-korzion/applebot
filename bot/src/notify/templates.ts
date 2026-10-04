// Шаблоны уведомлений (BOT-SPEC §12). Карта — всегда только последние 4 цифры; контакты — полностью при notify.fullContact.
import { maskEmail, maskPhone } from '../../../src/shared/log';

export interface RecipientView { firstName: string; lastName: string; email: string; phone: string }

export interface NotifyEvent {
  event: string;
  ts: string;
  machine: string;
  browser?: string;
  [k: string]: unknown;
}

/** События, которые уходят наружу (§12). */
export const NOTIFY_EVENTS = [
  'run.started', 'store.closed', 'store.opened', 'browser.admitted', 'strategy.switched', 'order.in_bag',
  'pay.3ds', 'applepay.qr', 'order.placed', 'card.declined', 'card.swapped', 'cards.exhausted',
  'human.needed', 'browser.blocked', 'proxy.down', 'browser.dead', 'run.summary',
] as const;

/** В Telegram — только в закреплённом статусе, отдельным сообщением не шлём. */
export const STATUS_ONLY = new Set(['browser.admitted', 'order.in_bag']);
/** Со звуком в Telegram (остальные — тихо). */
export const LOUD = new Set(['pay.3ds', 'applepay.qr', 'human.needed', 'order.placed', 'card.declined', 'browser.dead', 'proxy.down', 'browser.blocked']);

export function recipientOut(r: RecipientView | undefined, full: boolean): RecipientView | undefined {
  if (!r) return undefined;
  return full ? { ...r } : { firstName: r.firstName, lastName: r.lastName ? `${r.lastName[0]}.` : '', email: maskEmail(r.email), phone: maskPhone(r.phone) };
}

const HUMAN_REASON: Record<string, string> = {
  '3ds_input': '3-D Secure: банк просит ввод на странице', applepay_qr: 'QR Apple Pay', payment: 'оплата', captcha: 'капча «я не робот»',
  assist: 'нужен клик (ассистент)', blocked: 'браузер с заказом заблокирован', stuck: 'зависание', validation: 'ошибка в данных',
  proxy_down: 'прокси упал', dead: 'браузер упал', other: 'нужен человек',
};

function who(r: RecipientView | undefined): string[] {
  if (!r) return [];
  return [`Получатель: ${r.firstName} ${r.lastName}`.trim(), `${r.phone} · ${r.email}`];
}

function orderLine(o: any): string {
  if (!o) return '';
  return [o.title ?? o.part, o.total].filter(Boolean).join(' · ');
}

/** Текст для Telegram и файла уведомлений. */
export function telegramText(e: NotifyEvent): string {
  const o = (e.order ?? {}) as any;
  const r = e.recipient as RecipientView | undefined;
  const b = e.browser ? ` · ${e.browser}` : '';
  const card = (e.payment as any)?.cardLast4 ? `Карта ****${(e.payment as any).cardLast4}` : (e.cardLast4 ? `Карта ****${e.cardLast4}` : '');
  switch (e.event) {
    case 'run.started':
      return [`▶️ Старт ${e.machine}: браузеров ${e.browsers}, заказов ${e.orders}, карт ${e.cards}, прокси ${e.proxies}`, `openAt ${e.openAt}${e.stopBeforePay ? ' · ПРОБНЫЙ ПРОГОН (стоп на Review)' : ''}`].join('\n');
    case 'store.closed': return `⛔️ Apple Store закрыт (${e.reason ?? ''})${b}`;
    case 'store.opened': return `🟢 Apple Store открылся / OPEN (${e.reason ?? ''})${b}`;
    case 'browser.admitted': return `🚪 Пустили${b} (${e.strategy}, ${e.proxy ?? 'dir'}) +${e.sinceOpenSec ?? '?'} с`;
    case 'strategy.switched': return `🔀 Стратегия: ${(e.browsers as string[] | undefined)?.join(', ') ?? ''} → ${e.to} (${e.reason ?? ''})`;
    case 'order.in_bag': return `🛍 Заказ ${o.id ?? e.orderId}: в корзине${b}`;
    case 'pay.3ds':
      return [`🔐 Подтверди оплату в приложении банка`, `Заказ ${o.id ?? ''} · ${orderLine(o)}`, card, ...who(r), e.input ? '⚠️ Банк просит ввод на странице — окно впереди' : ''].filter(Boolean).join('\n');
    case 'applepay.qr':
      return [`📱 Сканируй QR Apple Pay — окно на весь экран`, `Заказ ${o.id ?? ''} · ${orderLine(o)}`, ...who(r), e.browser ?? ''].filter(Boolean).join('\n');
    case 'order.placed':
      return [
        `✅ Заказ ${o.number ?? ''}`,
        orderLine(o),
        ...who(r),
        [o.storeName, o.slot].filter(Boolean).join(' · '),
        [card, e.browser, e.proxy, (e.timings as any)?.openToOrderSec !== undefined ? `${Math.round((e.timings as any).openToOrderSec)} с от OPEN` : ''].filter(Boolean).join(' · '),
      ].filter(Boolean).join('\n');
    case 'card.declined':
      return [`❌ Отказ карты ${card.replace('Карта ', '')}`, `Заказ ${o.id ?? e.orderId}${b} → Apple Pay`, `«${String(e.text ?? '').slice(0, 160)}»`, ...who(r)].filter(Boolean).join('\n');
    case 'card.swapped': return `🔁 Карта ****${e.from ?? '?'} → ****${e.to ?? '?'} · заказ ${e.orderId}${b}`;
    case 'cards.exhausted': return `⚠️ Запасные карты кончились — браузеры с картой ****${e.cardLast4 ?? '?'} переходят на Apple Pay`;
    case 'human.needed':
      return [`🙋 Нужен человек${b}: ${HUMAN_REASON[String(e.reason)] ?? e.reason}`, e.orderId ? `Заказ ${e.orderId}` : '', String(e.text ?? '').slice(0, 300), ...who(r)].filter(Boolean).join('\n');
    case 'browser.blocked': return `🚫 Блокировка${b} (${e.proxy ?? 'dir'}, ${e.status ?? ''})${e.orderId ? ` · заказ ${e.orderId} — к человеку` : e.relaunched ? ` → перезапуск на ${e.relaunched}` : ''}`;
    case 'proxy.down': return `📡 Прокси ${e.proxy} не отвечает: ${e.error ?? ''}${(e.browsers as string[] | undefined)?.length ? ` · браузеры ${(e.browsers as string[]).join(', ')}` : ''}`;
    case 'browser.dead': return `💀 Браузер ${e.browser} упал${e.orderId ? ` · заказ ${e.orderId}` : ''}${e.placed ? ' · Place Order был нажат — к человеку' : e.relaunch ? ' → перезапуск' : ''}`;
    case 'run.summary': return `📊 Итог ${e.machine}: ${e.text ?? ''}`;
    case 'stock.gone': return `⏪ Сток кончился через ${e.afterSec ?? '?'} с${b}: ${e.detail ?? ''} — все без оплаты снова ждут сток`;
    default: return `${e.event}${b}`;
  }
}

/** Блок для файла заказов (orders.txt) — полные данные владельцу. */
export function orderFileBlock(e: NotifyEvent): string {
  const o = (e.order ?? {}) as any;
  const r = e.recipient as RecipientView | undefined;
  const p = (e.payment ?? {}) as any;
  return [
    `=== ${e.ts} · ${e.machine} · ${e.browser ?? ''} ===`,
    `Заказ ${o.id ?? ''}: ${o.number ?? ''}`,
    `Товар: ${o.title ?? ''} (${o.part ?? ''}) · ${o.total ?? ''}`,
    `Магазин: ${o.storeName ?? o.store ?? ''} · ${o.slot ?? ''}`,
    r ? `Получатель: ${r.firstName} ${r.lastName} · ${r.phone} · ${r.email}` : '',
    `Оплата: ${p.method === 'card' ? `карта ****${p.cardLast4 ?? ''}` : 'Apple Pay'}`,
    '',
  ].filter((x) => x !== null).join('\n');
}

/** Кнопки Telegram для человека (§12: human.needed — с кнопками). */
export function humanButtons(browser: string): { text: string; callback_data: string }[][] {
  return [[
    { text: `Показать ${browser}`, callback_data: `show:${browser}` },
    { text: 'Дальше', callback_data: 'next' },
    { text: `Стоп ${browser}`, callback_data: `stop:${browser}` },
  ]];
}

/** Проверка: в тексте/JSON нет полных номеров карт и токенов (для тестов и самоконтроля). */
export function leaksSecrets(s: string, cardNumbers: string[], tokens: string[] = []): string | null {
  for (const n of cardNumbers) if (n && s.includes(n)) return `номер карты ****${n.slice(-4)}`;
  for (const t of tokens) if (t && t.length >= 8 && s.includes(t)) return 'токен';
  if (/atbtoken=[0-9a-f]{5,}/i.test(s)) return 'atbtoken';
  return null;
}
