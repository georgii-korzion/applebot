// Оплата (§3.8, §7.7) — граница автоматизации.
// Расширение: выбирает способ, заполняет карту из конфига (если задана), нажимает «Review Your Order»
// (autoReview), для Apple Pay пробует открыть лист с кодом. Place Order / подтверждение Apple Pay — только человек.
import { SEL } from '../../shared/selectors';
import { storeName } from '../../shared/parts';
import type { Ctl } from '../ctl';
import { assistClick } from '../assist';
import { clickEl, clickable, isChecked, pickRadio, resolveInput, setInput, sleep, textOf, waitForUrl, waitUntil } from '../dom';
import { findEl, findField, waitEl, waitEnabled } from '../find';

const REVIEW_URL = /_s=Review/i;

export async function paymentStep(c: Ctl): Promise<void> {
  const sig = c.signal;
  const o = c.order!;
  if (['PAY_QUEUE', 'PAYING', 'REVIEW', 'ORDERED', 'NEED_HUMAN'].includes(c.ts.state)) {
    // вернулись на Billing (например, из Review) — ничего не трогаем, человек в процессе
    if (c.ts.state === 'PAYING' && c.ts.payTurn) await onTurn(c);
    else showPayBanner(c);
    return;
  }
  c.setState('BILLING', 'выбор способа оплаты');
  await waitUntil(() => findEl('payCard') || findEl('payApplePay'), 12000, sig);
  let method = o.payment;
  if (method === 'applepay') {
    const ap = findEl('payApplePay');
    if (!ap) {
      if (o.applePayFallback === 'manual') {
        c.log('Apple Pay недоступен — фолбэк на карту (applePayFallback=manual)', 'warn');
        method = 'manual';
      } else {
        c.setState('NEED_HUMAN', 'Apple Pay недоступен, фолбэк выключен — выбери способ оплаты сам');
        c.alert(`Заказ ${o.id}: оплата`, 'Apple Pay недоступен — выбери способ оплаты в окне');
        c.overlay.banner(`${payLabel(c)} · Apple Pay недоступен`, 'Выбери способ оплаты сам; расширение ничего не вводит', 'warn');
        return;
      }
    } else if (!isChecked(ap)) pickRadio(ap);
  }
  if (method === 'manual') {
    const card = findEl('payCard');
    if (card && !isChecked(card)) pickRadio(card);
    await fillCard(c);
  }
  c.ts.payMethod = method;
  c.ts.billingAt = Date.now();
  c.setState('PAY_QUEUE', 'в очереди на оплату');
  c.send({ t: 'BILLING_READY', store: c.ts.store ?? '', slot: c.ts.slot ?? '', slotLabel: c.ts.slotLabel ?? '', method, price: c.ts.price, cardFilled: !!c.ts.cardFilled });
  showPayBanner(c);
}

/** Карта из конфига: номер, срок, CVV, имя. Данные не логируются; в лог — только последние 4 цифры. */
async function fillCard(c: Ctl): Promise<void> {
  const card = c.order?.card;
  const num = await waitUntil(() => findField('cardNumber'), 5000, c.signal);
  if (!num) { c.log('поле card-number-input не найдено', 'warn'); return; }
  num.scrollIntoView({ block: 'center' });
  if (!card?.number) { num.focus(); return; } // карта не задана — только фокус, вводит человек
  const digits = card.number.replace(/\D/g, '');
  const fields: [HTMLInputElement | null, string, string][] = [
    [num, digits, 'номер'],
    [findField('cardExpiry'), card.expiry, 'срок'],
    [findField('cardCvv'), card.cvv, 'CVV'],
    [findField('cardName'), card.name, 'имя'],
  ];
  const done: string[] = [];
  const missed: string[] = [];
  for (const [f, val, label] of fields) {
    if (!val) continue;
    if (!f) { missed.push(label); continue; }
    setInput(f, val);
    await sleep(80, c.signal);
    const ok = f.value.replace(/\D/g, '') === val.replace(/\D/g, '') || f.value === val;
    (ok ? done : missed).push(label);
  }
  c.ts.cardFilled = done.includes('номер');
  c.log(`карта ****${digits.slice(-4)}: заполнено ${done.join(', ') || '—'}${missed.length ? `; не удалось: ${missed.join(', ')}` : ''}`, missed.length ? 'warn' : 'info');
  if (missed.length) c.overlay.banner(`${payLabel(c)} · допиши ${missed.join(', ')}`, 'Остальное расширение заполнило', 'warn');
}

export function payLabel(c: Ctl): string {
  const parts = [`Заказ ${c.order?.id ?? ''}`];
  if (c.ts.store) parts.push(storeName(c.ts.store).replace(/^Apple /, ''));
  if (c.ts.slotLabel) parts.push(c.ts.slotLabel);
  return parts.join(' · ');
}

export function showPayBanner(c: Ctl): void {
  const label = payLabel(c);
  const dup = 'Если после Place Order ошибка — не жми снова: проверь почту и номер заказа, заказ мог пройти (12.09 у людей вышли дубли).';
  if (c.ts.state === 'PAY_QUEUE') {
    c.overlay.banner(`${label} · в очереди на оплату`, 'Окно выйдет вперёд со звуком, когда подойдёт очередь', 'info');
  } else if (c.ts.state === 'PAYING') {
    const what = c.ts.payMethod === 'applepay'
      ? 'Apple Pay: сканируй код телефоном и подтверди'
      : c.ts.cardFilled ? 'карта заполнена — проверь и нажми Review → Place Order' : 'введи карту и нажми Review → Place Order';
    c.overlay.banner(`${label} · ${what}`, `Финальное действие — за тобой. ${dup}`, 'warn');
  } else if (c.ts.state === 'REVIEW') {
    c.overlay.banner(`${label} · ${c.ts.payMethod === 'applepay' ? 'Apple Pay: код телефоном → подтверди' : 'нажми Place Order'}`, `Расширение только наблюдает. ${dup}`, 'warn');
  }
  c.renderOverlay({ timerSince: c.ts.slotAt, timerLabel: 'слот выбран' });
}

/** Очередь дошла до этой вкладки (FOCUS_FOR_PAY). */
export function onFocusForPay(c: Ctl): void {
  if (c.ts.state === 'ORDERED') return;
  c.ts.payStartedAt ??= Date.now();
  c.ts.payTurn = true;
  if (c.ts.state !== 'REVIEW') c.setState('PAYING', c.ts.payMethod === 'applepay' ? 'Apple Pay' : 'карта → Review → Place Order');
  showPayBanner(c);
  void onTurn(c).catch(() => {});
}

/** Наш ход: с Billing — на Review (autoReview), на Review для Apple Pay — открыть лист с кодом. */
async function onTurn(c: Ctl): Promise<void> {
  const sig = c.signal;
  if (REVIEW_URL.test(location.href)) { await tryApplePay(c); return; }
  if (!c.order?.autoReview) {
    if (c.ts.payMethod === 'manual') { const f = findField('cardNumber'); if (f && !c.ts.cardFilled) f.focus(); }
    return;
  }
  const btn = await waitEnabled('reviewButton', 4000, sig);
  if (!btn) { c.log('кнопка Review Your Order не активна — дальше человек', 'warn'); return; }
  if (findEl('termsCheckbox')) await acceptTerms(c, 1000); // иногда условия уже на Billing
  c.setState('PAYING', 'Review Your Order');
  clickEl(btn);
  const went = await waitForUrl(REVIEW_URL, 15000, sig);
  if (!went) {
    const err = /Please\s[^.\n]{3,120}|unexpected error|something went wrong/i.exec(document.body?.innerText ?? '')?.[0];
    c.setState('PAYING', `Review не открылся${err ? `: ${err}` : ''} — проверь форму и нажми Review сам`);
    c.overlay.banner(`${payLabel(c)} · проверь форму оплаты и нажми Review Your Order`, err ?? 'Расширение дальше не жмёт', 'warn');
  }
}

/**
 * Apple Pay в Chrome: лист с кодом для iPhone открывает браузер, и ему нужен настоящий клик пользователя —
 * программный клик Chrome отвергает (правило браузера, не защита Apple). Пробуем один раз; если лист не
 * открылся — подсвечиваем кнопку, один клик человека, дальше он сканирует код телефоном.
 */
async function tryApplePay(c: Ctl): Promise<void> {
  if (c.ts.payMethod !== 'applepay' || c.ts.applePayTried) return;
  c.ts.applePayTried = true;
  void c.save();
  const btn = await waitUntil(() => findEl('applePayButton'), 5000, c.signal);
  if (!btn) { c.log('кнопка Apple Pay на Review не найдена — жми сам', 'warn'); showPayBanner(c); return; }
  await acceptTerms(c, 2500); // обязательно до клика по оплате — иначе «Please read and accept the terms & conditions»
  clickEl(btn);
  await sleep(900, c.signal);
  if (termsErrorShown()) {
    c.log('Apple: «read and accept the terms» — ставлю галочку и жму Apple Pay ещё раз', 'warn');
    await acceptTerms(c, 3000);
    clickEl(btn);
    await sleep(900, c.signal);
  }
  // лист Apple Pay — окно браузера поверх страницы: страница теряет фокус
  if (!document.hasFocus()) {
    c.setState('PAYING', 'Apple Pay: лист открыт — сканируй код телефоном');
    c.overlay.banner(`${payLabel(c)} · сканируй код телефоном и подтверди`, 'Расширение ничего не подтверждает', 'warn');
    return;
  }
  c.log('программный клик Apple Pay лист не открыл (нужен клик человека)', 'warn');
  await assistClick(c, clickable(btn), 'Apple Pay', 'Нажми Apple Pay — откроется код для iPhone');
  c.setState('PAYING', 'Apple Pay: сканируй код телефоном');
  showPayBanner(c);
}

export function reviewStep(c: Ctl): void {
  if (c.ts.state === 'ORDERED') return;
  c.setState('REVIEW', c.ts.payMethod === 'applepay' ? 'Apple Pay (человек)' : 'ждём Place Order (человек)');
  showPayBanner(c);
  watchForOrderNo(c);
  // галочка Terms & Conditions — при любом способе оплаты, до того как человек/расширение нажмёт оплату
  void (async () => { await acceptTerms(c, 4000); if (c.ts.payTurn) await tryApplePay(c); })().catch(() => {});
}

/**
 * Review: «I have read, understand, and agree to the Terms & Conditions of Sale» — без галочки Apple не принимает
 * заказ (18 Pro, live: «Please read and accept the terms & conditions of this order.»). Это не оплата, ставим сами.
 */
async function acceptTerms(c: Ctl, wait = 4000): Promise<boolean> {
  const el = await waitEl('termsCheckbox', wait, c.signal);
  if (!el) {
    if (wait >= 2000) c.log('чекбокс Terms & Conditions не найден — если он на экране, поставь галочку сам', 'warn');
    return false;
  }
  const input = resolveInput(el) ?? (el as HTMLInputElement);
  if (input.checked) return true;
  input.scrollIntoView({ block: 'center' });
  input.click();
  let ok = await waitUntil(() => (input.checked ? input : null), 1500, c.signal);
  if (!ok) {
    const label = input.labels?.[0] ?? input.closest('label');
    if (label) { (label as HTMLElement).click(); ok = await waitUntil(() => (input.checked ? input : null), 1500, c.signal); }
  }
  if (ok) { c.log('условия продажи (Terms & Conditions) приняты'); return true; }
  c.log('не удалось поставить галочку Terms & Conditions — поставь сам', 'warn');
  c.overlay.banner(`${payLabel(c)} · поставь галочку Terms & Conditions`, 'Без неё Apple не примет заказ', 'warn');
  return false;
}

function termsErrorShown(): boolean {
  return SEL.txtTermsError.test(document.body?.innerText ?? '');
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
