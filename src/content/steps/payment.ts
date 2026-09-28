// Оплата (§3.8, §7.7) — граница автоматизации.
// Расширение ТОЛЬКО выбирает способ оплаты и ставит фокус в поле карты.
// Карту/CVV не вводит, Review / Place Order / Pay не нажимает.
import { SEL } from '../../shared/selectors';
import { storeName } from '../../shared/parts';
import type { Ctl } from '../ctl';
import { findField, isChecked, pickRadio, q, textOf, waitUntil } from '../dom';

export async function paymentStep(c: Ctl): Promise<void> {
  const sig = c.signal;
  const o = c.order!;
  if (c.ts.state === 'PAY_QUEUE' || c.ts.state === 'PAYING' || c.ts.state === 'REVIEW') {
    // вернулись на Billing (например, из Review) — ничего не трогаем, человек в процессе
    showPayBanner(c);
    return;
  }
  c.setState('BILLING', 'выбор способа оплаты');
  await waitUntil(() => q(SEL.payCard) || q(SEL.payApplePay), 12000, sig);
  let method = o.payment;
  if (method === 'applepay') {
    const ap = q(SEL.payApplePay);
    if (!ap) {
      if (o.applePayFallback === 'manual') {
        c.log('Apple Pay недоступен — фолбэк на карту (applePayFallback=manual)', 'warn');
        method = 'manual';
      } else {
        c.setState('STUCK', 'Apple Pay недоступен, фолбэк выключен');
        c.alert(`Заказ ${o.id}: оплата`, 'Apple Pay недоступен');
        return;
      }
    } else if (!isChecked(ap)) pickRadio(ap);
  }
  if (method === 'manual') {
    const card = q(SEL.payCard);
    if (card && !isChecked(card)) pickRadio(card);
    await focusCard(c);
  }
  c.ts.payMethod = method;
  c.ts.billingAt = Date.now();
  c.setState('PAY_QUEUE', 'в очереди на оплату');
  c.send({ t: 'BILLING_READY', store: c.ts.store ?? '', slot: c.ts.slot ?? '', slotLabel: c.ts.slotLabel ?? '', method });
  showPayBanner(c);
}

async function focusCard(c: Ctl): Promise<void> {
  const f = await waitUntil(() => findField(SEL.cardNumberFocusOnly), 5000, c.signal);
  if (f) {
    f.scrollIntoView({ block: 'center' });
    f.focus(); // только фокус, без ввода
  } else c.log('поле card-number-input не найдено', 'warn');
}

export function payLabel(c: Ctl): string {
  const parts = [`Заказ ${c.order?.id ?? ''}`];
  if (c.ts.store) parts.push(storeName(c.ts.store).replace(/^Apple /, ''));
  if (c.ts.slotLabel) parts.push(c.ts.slotLabel);
  return parts.join(' · ');
}

export function showPayBanner(c: Ctl): void {
  const label = payLabel(c);
  if (c.ts.state === 'PAY_QUEUE') {
    c.overlay.banner(`${label} · в очереди на оплату`, 'Окно выйдет вперёд со звуком, когда подойдёт очередь', 'info');
  } else if (c.ts.state === 'PAYING') {
    const what = c.ts.payMethod === 'applepay'
      ? 'подтверди Apple Pay (кнопка оплаты + Touch ID / iPhone)'
      : 'введи карту и нажми Review → Place Order';
    c.overlay.banner(`${label} · ${what}`, 'Финальное действие — за тобой. Расширение ничего не вводит и не нажимает.', 'warn');
  } else if (c.ts.state === 'REVIEW') {
    c.overlay.banner(`${label} · нажми Place Order`, 'Расширение только наблюдает', 'warn');
  }
  c.renderOverlay({ timerSince: c.ts.slotAt, timerLabel: 'слот выбран' });
}

/** Очередь дошла до этой вкладки (FOCUS_FOR_PAY). */
export function onFocusForPay(c: Ctl): void {
  if (c.ts.state === 'ORDERED') return;
  c.ts.payStartedAt ??= Date.now();
  if (c.ts.state !== 'REVIEW') c.setState('PAYING', c.ts.payMethod === 'applepay' ? 'подтверди Apple Pay' : 'введи карту → Review → Place Order');
  showPayBanner(c);
  if (c.ts.payMethod === 'manual' && c.ts.state === 'PAYING') void focusCard(c).catch(() => {});
}

export function reviewStep(c: Ctl): void {
  if (c.ts.state === 'ORDERED') return;
  c.setState('REVIEW', 'ждём Place Order (человек)');
  showPayBanner(c);
  watchForOrderNo(c);
}

let orderObserver: MutationObserver | null = null;

/** Номер заказа W\d{9,11} → ORDERED. */
export function watchForOrderNo(c: Ctl): void {
  if (orderObserver) return;
  const check = () => {
    const t = document.body?.innerText ?? '';
    const m = SEL.txtOrderNo.exec(t);
    if (m && SEL.txtThanks.test(t)) { orderObserver?.disconnect(); orderObserver = null; ordered(c, m[0]); }
  };
  orderObserver = new MutationObserver(check);
  orderObserver.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  check();
}

export function ordered(c: Ctl, orderNo: string): void {
  if (c.ts.state === 'ORDERED' && c.ts.orderNo === orderNo) return;
  c.ts.orderNo = orderNo;
  c.setState('ORDERED', `номер заказа ${orderNo}`);
  c.send({ t: 'ORDERED', orderNo });
  c.overlay.banner(`✅ ${payLabel(c)} · заказ ${orderNo}`, textOf(document.querySelector('h1')) || undefined, 'ok');
}

/** Таймаут ручной оплаты (§7.7 п. 6). */
export function checkPayTimeout(c: Ctl): void {
  if (!c.ts.payStartedAt || !['PAYING', 'REVIEW'].includes(c.ts.state)) return;
  if (Date.now() - c.ts.payStartedAt > c.t.manualPayTimeoutSec * 1000) {
    c.setState('PAY_TIMEOUT', `нет подтверждения ${c.t.manualPayTimeoutSec} с`);
    c.alert(`Заказ ${c.order?.id}: PAY_TIMEOUT`, 'Оплата не подтверждена — проверь окно');
  }
}
