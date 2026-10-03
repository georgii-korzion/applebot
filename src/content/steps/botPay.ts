// Оплата в режиме бота (BOT-SPEC §9): ворота Place Order по карте, разбор исхода, отказ карты,
// смена карты / переход на Apple Pay, лестница кликов Apple Pay (программный → CDP → ОС → человек), повтор QR.
// Инварианты против дублей: один клик Place Order на попытку оплаты (флаг в состоянии вкладки, переживает
// перезагрузку); повтор — только после явного отказа и только другим способом (Apple Pay).
import { SEL } from '../../shared/selectors';
import { THREEDS_RE, isDeclineText, type ClickTarget } from '../../shared/bot';
import type { Ctl } from '../ctl';
import { assistClick } from '../assist';
import { clickEl, clickable, isChecked, isEnabled, isVisible, pickRadio, qa, sleep, textOf, waitForUrl, waitUntil } from '../dom';
import { findEl, waitEnabled } from '../find';
import { acceptTerms, fillBillingAddress, fillCard, payLabel, showPayBanner, termsErrorShown, waitCardFields, watchForOrderNo } from './payment';
import { snapshot } from './bot';
import { classify } from '../classify';

let placing = false;
let applePaying = false;
let placeTurnAt = 0;

/** PLACE_TURN пришёл без ожидающего запроса (после таймаута запроса) — запомнить. */
export function notePlaceTurn(): void { placeTurnAt = Date.now(); }

function last4(c: Ctl): string {
  return (c.order?.card.number ?? '').slice(-4);
}

/** Тексты ошибок на странице (alert-области), без ошибки про галочку условий. */
function errorTexts(): string {
  return qa<HTMLElement>('[role="alert"], [aria-live="assertive"], [aria-live="polite"], [class*="error" i], [class*="alert" i]')
    .filter((e) => isVisible(e))
    .map(textOf).filter((t) => t && !SEL.txtTermsError.test(t)).join(' | ').slice(0, 400);
}

/** Окно / фрейм банка на странице: большой видимый iframe не с apple.com. */
function bankFrame(): boolean {
  return qa<HTMLIFrameElement>('iframe').some((f) => {
    const r = f.getBoundingClientRect();
    if (r.width < 200 || r.height < 150 || !isVisible(f)) return false;
    const src = f.src || '';
    return !src || !/apple\.com|127\.0\.0\.1|localhost/i.test(new URL(src, location.href).hostname);
  });
}

function threeDsText(): string | null {
  for (const d of qa<HTMLElement>('[role="dialog"], dialog[open], [aria-modal="true"]')) {
    if (!isVisible(d)) continue;
    const m = THREEDS_RE.exec(d.innerText ?? '');
    if (m) return m[0];
  }
  return null;
}

type Outcome = { kind: 'ordered' } | { kind: 'terms' } | { kind: 'declined'; text: string } | { kind: '3ds'; input: boolean; text: string } | { kind: 'error'; text: string };

function detectOutcome(before: string): Outcome | null {
  const body = document.body?.innerText ?? '';
  if (SEL.txtOrderNo.test(body) && SEL.txtThanks.test(body)) return { kind: 'ordered' };
  if (termsErrorShown()) return { kind: 'terms' };
  const errs = errorTexts();
  const fresh = errs && errs !== before ? errs : '';
  if (fresh && isDeclineText(fresh)) return { kind: 'declined', text: fresh };
  if (bankFrame()) return { kind: '3ds', input: true, text: 'фрейм банка' };
  const t = threeDsText();
  if (t) return { kind: '3ds', input: false, text: t };
  if (fresh) return { kind: 'error', text: fresh };
  return null;
}

// ---------- карта: Place Order ----------
/** Place Order в режиме бота: ворота PLACE_REQ/PLACE_TURN (одно ожидающее подтверждение на карту, §9.1). */
export async function botPlaceOrder(c: Ctl): Promise<void> {
  if (c.ts.payMethod !== 'manual' || c.ts.placeOrderTried || placing) return;
  if (c.b?.stopBeforePay) { await acceptTerms(c, 3000); c.setState('REVIEW', 'стоп перед оплатой (пробный прогон) — Place Order не нажимаю'); return; }
  placing = true;
  try {
    const btn = await waitEnabled('placeOrderButton', 8000, c.signal);
    if (!btn) {
      c.log('кнопка Place Order не найдена или не активна — нажми сам', 'warn');
      c.needHuman('payment', 'нет активной кнопки Place Order');
      showPayBanner(c);
      return;
    }
    const terms = await acceptTerms(c, 3000);
    if (!terms && findEl('termsCheckbox')) { c.needHuman('payment', 'галочка условий не ставится'); showPayBanner(c); return; }
    c.setState('PLACE_WAIT', `жду очередь по карте ****${last4(c)}`);
    if (!(await placeGate(c))) return;
    const b2 = findEl('placeOrderButton');
    if (c.ts.placeOrderTried || c.ts.swapPending || !b2 || !isEnabled(b2)) return;
    if (!(await acceptTerms(c, 1500)) && findEl('termsCheckbox')) { c.needHuman('payment', 'галочка условий не ставится'); return; }
    const before = errorTexts();
    c.ts.placeOrderTried = true;
    c.ts.placeOrderAt = Date.now();
    c.ts.payAttempt ??= 1;
    c.ts.placedAttempt = c.ts.payAttempt;
    await c.save();
    c.log(`Place Order нажат (карта ****${last4(c)}) — подтверждение банка (3-D Secure) за человеком`);
    clickEl(b2);
    c.send({ t: 'PLACED', at: c.ts.placeOrderAt });
    c.setState('PLACED', 'Place Order нажат — жду ответ сайта');
    showPayBanner(c);
    await placeOutcome(c, before, b2);
  } finally {
    placing = false;
  }
}

async function placeGate(c: Ctl): Promise<boolean> {
  const since = Date.now();
  const sig = c.signal; // шаг прервали (смена карты / Apple Pay / навигация) — ворота больше не ждём
  const card = c.order?.cardId;
  const gone = () => sig.aborted || !!c.ts.swapPending || c.ts.payMethod !== 'manual' || c.order?.cardId !== card;
  for (let i = 0; ; i++) {
    if (placeTurnAt >= since && !gone()) return true;
    const r = await c.request({ t: 'PLACE_REQ' }, 'PLACE_TURN', 10_000, sig);
    if (gone()) return false;
    if (r || placeTurnAt >= since) {
      if (r?.local) c.log('очередь по карте без хаба — жму сам', 'warn');
      return true;
    }
    c.setState('PLACE_WAIT', `жду очередь по карте ****${last4(c)} (${Math.round((Date.now() - since) / 1000)} с): по этой карте уже ждут подтверждения банка`);
  }
}

/** Исход после Place Order (§9.1): номер → ORDERED; банк → WAIT_3DS; отказ → CARD_DECLINED; иное → NEED_HUMAN. Повторно не жмём. */
async function placeOutcome(c: Ctl, before: string, btn: HTMLElement | null): Promise<void> {
  let termsRetried = false;
  for (;;) {
    const r = await waitUntil(() => detectOutcome(before), 30_000, c.signal);
    if (!r) {
      if (c.ts.state === 'ORDERED') return;
      return needHumanAfterPlace(c, 'нет ответа сайта 30 с после Place Order');
    }
    switch (r.kind) {
      case 'ordered':
        watchForOrderNo(c);
        return;
      case 'terms':
        // заказ не отправлялся (Apple не приняла без галочки) — галочка и один повтор
        if (termsRetried || !btn) return needHumanAfterPlace(c, 'Apple просит принять условия');
        termsRetried = true;
        c.log('Apple: «read and accept the terms» после Place Order — заказ не отправлялся; галочка и ещё один клик', 'warn');
        if (await acceptTerms(c, 3000)) { clickEl(btn); await sleep(300, c.signal); }
        continue;
      case 'declined':
        return declined(c, r.text);
      case '3ds':
        return wait3ds(c, r.input, r.text);
      case 'error':
        return needHumanAfterPlace(c, r.text);
    }
  }
}

function needHumanAfterPlace(c: Ctl, text: string): void {
  c.ts.payOutcome = 'NEED_HUMAN';
  void c.save();
  c.setState('NEED_HUMAN', `после Place Order: ${text.slice(0, 150)} — повторно не жму; проверь почту и номер заказа`);
  c.overlay.banner(`${payLabel(c)} · после Place Order: ${text.slice(0, 80)}`, 'Бот повторно не жмёт: сначала почта и номер заказа, заказ мог пройти (12.09 были дубли)', 'warn');
  snapshot(c, classify(), 'after-place', true);
  c.needHuman('payment', `после Place Order: ${text.slice(0, 200)}`);
  watchForOrderNo(c);
}

function declined(c: Ctl, text: string): void {
  c.ts.payOutcome = 'CARD_DECLINED';
  void c.save();
  c.setState('CARD_DECLINED', `отказ карты ****${last4(c)}: ${text.slice(0, 120)}`);
  c.overlay.banner(`${payLabel(c)} · карта ****${last4(c)} отклонена`, 'Бот переходит на Apple Pay — вторая и последняя автоматическая попытка', 'warn');
  c.send({ t: 'CARD_DECLINED', text: text.slice(0, 300) });
}

async function wait3ds(c: Ctl, input: boolean, why: string): Promise<void> {
  const fresh = c.ts.payOutcome !== 'WAIT_3DS';
  c.ts.payOutcome = 'WAIT_3DS';
  c.ts.threeDsSince ??= Date.now();
  void c.save();
  c.setState('WAIT_3DS', input ? 'банк просит ввод на странице — окно впереди' : `подтверди оплату в приложении банка (${why})`);
  if (fresh) c.send({ t: 'PAY_WAIT', kind: '3ds', input, detail: why });
  watchForOrderNo(c);
  const total = (c.b?.threeDsTimeoutSec ?? 300) * 1000;
  const left = Math.max(1000, total - (Date.now() - c.ts.threeDsSince));
  const before = errorTexts();
  const r = await waitUntil(() => {
    const e = errorTexts();
    return e && e !== before && isDeclineText(e) ? e : null;
  }, left, c.signal);
  if (c.ts.state === 'ORDERED') return;
  if (r) return declined(c, r);
  // таймаут 3-D Secure карту не сжигает (burnOn3dsTimeout=false) — человек
  needHumanAfterPlace(c, `3-D Secure: нет подтверждения ${Math.round(total / 1000)} с`);
}

/** Place Order нажат на текущей попытке оплаты (после SWITCH_PAY на Apple Pay — уже нет). */
export function placedThisAttempt(c: Ctl): boolean {
  return !!c.ts.placeOrderTried && (c.ts.placedAttempt ?? 1) === (c.ts.payAttempt ?? 1);
}

/** Вкладка перезагрузилась после Place Order: только наблюдаем исход, никогда не жмём снова. */
export async function resumePlaced(c: Ctl): Promise<void> {
  watchForOrderNo(c);
  switch (c.ts.payOutcome) {
    case 'CARD_DECLINED': c.setState('CARD_DECLINED', 'карта отклонена — жду перехода на Apple Pay'); return;
    case 'NEED_HUMAN': c.setState('NEED_HUMAN', c.ts.detail ?? 'после Place Order нужен человек'); showPayBanner(c); return;
    case 'WAIT_3DS': return wait3ds(c, false, 'после перезагрузки');
    default: return placeOutcome(c, '', null);
  }
}

// ---------- смена карты / способа оплаты (§9.3) ----------
/** Кнопка «Edit» блока оплаты на Review. */
function paymentEdit(): HTMLElement | null {
  const direct = document.querySelector<HTMLElement>('[data-autom="review-edit-payment"], [data-autom*="edit" i][data-autom*="pay" i], [data-autom*="billing" i][data-autom*="edit" i]');
  if (direct) return direct;
  return qa<HTMLElement>('a, button, [role="button"]').find((b) => {
    if (!isVisible(b) || !/^(edit|change)\b/i.test(textOf(b))) return false;
    let p: HTMLElement | null = b.parentElement;
    for (let i = 0; i < 4 && p; i++, p = p.parentElement) if (/payment|card|apple pay|billing/i.test(textOf(p).slice(0, 300))) return true;
    return false;
  }) ?? null;
}

/** С Review назад на Billing: «Edit» у оплаты → history.back() → прямой адрес шага. */
export async function goBilling(c: Ctl): Promise<void> {
  if (/_s=Billing/i.test(location.href)) { c.rerun('swap-on-billing'); return; }
  const edit = paymentEdit();
  if (edit) {
    clickEl(edit);
    if (await waitForUrl(/_s=Billing/i, 5000)) return;
  }
  history.back();
  if (await waitForUrl(/_s=Billing/i, 3000)) return;
  location.assign(`${location.pathname}?_s=Billing`);
}

export function onCardSwap(c: Ctl): void {
  if (c.ts.placeOrderTried) {
    c.log('CARD_SWAP: Place Order уже нажат — карту не меняю', 'warn');
    c.send({ t: 'CARD_SWAP_ACK', ok: false, detail: 'Place Order уже нажат' });
    return;
  }
  const onPay = c.ts.mode === 'checkout' && /_s=(Billing|Review)/i.test(location.href);
  if (!onPay) {
    // до Billing: новая карта уже в заказе — на странице делать нечего
    c.log(`карта заменена до Billing → ****${last4(c)}`);
    c.send({ t: 'CARD_SWAP_ACK', ok: true, detail: 'до Billing' });
    return;
  }
  c.ts.swapPending = 'card';
  c.ts.cardFilled = false;
  void c.save();
  c.log(`CARD_SWAP → ****${last4(c)}: назад на Billing`);
  c.stopAll();
  void goBilling(c).catch(() => {});
}

export function onSwitchPay(c: Ctl): void {
  c.ts.swapPending = 'applepay';
  c.ts.payAttempt = (c.ts.payAttempt ?? 1) + 1;
  c.ts.payOutcome = undefined;
  c.ts.applePayTried = false;
  c.ts.applePayOpens = 0;
  c.ts.payTurn = false;
  void c.save();
  c.log('SWITCH_PAY: оплата → Apple Pay');
  if (c.ts.mode !== 'checkout' || !/_s=(Billing|Review)/i.test(location.href)) return; // дойдём до Billing — там и выберем
  c.stopAll();
  void goBilling(c).catch(() => {});
}

/** Billing после CARD_SWAP / SWITCH_PAY: перезаполнить карту и адрес или выбрать Apple Pay, снова в очередь оплаты. */
export async function swapOnBilling(c: Ctl): Promise<void> {
  const sig = c.signal;
  const kind = c.ts.swapPending;
  c.setState('BILLING', kind === 'card' ? `смена карты → ****${last4(c)}` : 'переход на Apple Pay');
  await waitUntil(() => findEl('payCard') || findEl('payApplePay'), 12000, sig);
  if (kind === 'applepay') {
    const ap = findEl('payApplePay');
    if (!ap) {
      c.setState('NEED_HUMAN', 'Apple Pay недоступен — оплати сам');
      c.needHuman('payment', 'Apple Pay недоступен после отказа карты');
      return;
    }
    if (!isChecked(ap)) pickRadio(ap);
    await sleep(300, sig);
    c.ts.payMethod = 'applepay';
  } else {
    const card = findEl('payCard');
    if (card && !isChecked(card)) pickRadio(card);
    const num = await waitCardFields(c, card);
    if (!num) {
      c.send({ t: 'CARD_SWAP_ACK', ok: false, detail: 'поля карты не появились' });
      c.setState('NEED_HUMAN', 'смена карты: поля карты не появились — введи сам');
      c.needHuman('payment', 'смена карты: поля карты не появились');
      return;
    }
    await fillCard(c, num);
    await fillBillingAddress(c);
    c.ts.payMethod = 'manual';
    c.send({ t: 'CARD_SWAP_ACK', ok: !!c.ts.cardFilled, detail: c.ts.cardFilled ? `****${last4(c)}` : 'карта не заполнилась' });
  }
  c.ts.swapPending = undefined;
  c.ts.payTurn = false;
  c.ts.billingAt = Date.now();
  c.setState('PAY_QUEUE', `в очереди на оплату (${c.ts.payMethod === 'applepay' ? 'Apple Pay' : `карта ****${last4(c)}`})`);
  c.send({ t: 'BILLING_READY', store: c.ts.store ?? '', slot: c.ts.slot ?? '', slotLabel: c.ts.slotLabel ?? '', method: c.ts.payMethod, price: c.ts.price, cardFilled: !!c.ts.cardFilled });
  showPayBanner(c);
}

/** Apple Pay недоступен на Billing: карта из пула, если есть свободная (§9). */
export async function requestCard(c: Ctl): Promise<boolean> {
  c.setState('BILLING', 'Apple Pay недоступен — прошу карту у хаба');
  const r = await c.request({ t: 'CARD_REQ' }, 'CARD_SWAP', 5000);
  return !!r && !!c.order?.card.number;
}

// ---------- Apple Pay (§9.2) ----------
function clickTarget(btn: HTMLElement): ClickTarget {
  const r = btn.getBoundingClientRect();
  const chromeTop = Math.max(0, window.outerHeight - window.innerHeight);
  const chromeLeft = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
  return {
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    screen: { x: Math.round(window.screenX + chromeLeft + r.x + r.width / 2), y: Math.round(window.screenY + chromeTop + r.y + r.height / 2) },
    dpr: window.devicePixelRatio || 1,
  };
}

type Via = 'focus' | 'dom';

function domQr(): boolean {
  for (const el of qa<HTMLElement>(SEL.applePaySheet)) {
    const r = el.getBoundingClientRect();
    if (isVisible(el) && r.width > 40 && r.height > 40) return true;
  }
  for (const d of qa<HTMLElement>('[role="dialog"], dialog[open], [aria-modal="true"]')) {
    const r = d.getBoundingClientRect();
    if (r.width < 40 || r.height < 40 || !isVisible(d)) continue;
    const t = d.innerText ?? '';
    if (/apple ?pay|\bpay\b/i.test(t) && SEL.txtApplePayQr.test(t)) return true;
  }
  return false;
}

function qrVia(hadFocus: boolean): Via | null {
  if (domQr()) return 'dom';
  if (hadFocus && !document.hasFocus()) return 'focus';
  return null;
}

/** Наш ход на Review с Apple Pay: галочка → клик → QR → ждём номер; QR закрылся без заказа → снова (reopenTries). */
export async function botApplePay(c: Ctl): Promise<void> {
  if (c.ts.payMethod !== 'applepay' || applePaying) return;
  if (c.b?.stopBeforePay) { await acceptTerms(c, 3000); c.setState('REVIEW', 'стоп перед оплатой (пробный прогон) — Apple Pay не нажимаю'); return; }
  applePaying = true;
  try {
    const btn = await waitUntil(() => findEl('applePayButton'), 5000, c.signal);
    if (!btn) {
      c.setState('NEED_HUMAN', 'кнопка Apple Pay на Review не найдена — нажми сам');
      c.needHuman('payment', 'кнопка Apple Pay не найдена');
      return;
    }
    await acceptTerms(c, 2500);
    c.ts.payStartedAt ??= Date.now();
    for (;;) {
      const via = await openSheet(c);
      if (!via) return;
      const again = await qrLoop(c, via);
      if (!again) return;
    }
  } finally {
    applePaying = false;
  }
}

/** Лестница кликов (§9.2 п. 3): программный → настоящий клик CDP → клик macOS (флаг) → человек. */
async function openSheet(c: Ctl): Promise<Via | null> {
  const sig = c.signal;
  const ap = c.b?.applePay;
  const ladder: ('js' | 'cdp' | 'os' | 'human')[] = ['js'];
  if (ap?.cdpClick) ladder.push('cdp');
  if (ap?.osClick) ladder.push('os');
  ladder.push('human');
  for (const how of ladder) {
    let btn = findEl('applePayButton');
    if (!btn) { await sleep(500, sig); btn = findEl('applePayButton'); }
    if (!btn) break;
    btn.scrollIntoView({ block: 'center' });
    await sleep(120, sig);
    for (let terms = 0; terms < 2; terms++) {
      const hadFocus = document.hasFocus();
      if (how === 'js') clickEl(btn);
      else if (how === 'cdp' || how === 'os') {
        c.setState('APPLEPAY', `клик Apple Pay через ${how === 'cdp' ? 'CDP' : 'macOS'}`);
        const r = await c.request({ t: 'CLICK_REQ', purpose: 'applepay', how, target: clickTarget(btn) }, 'CLICK_DONE', 10_000, sig);
        if (!r?.ok) { c.log(`клик ${how}: ${r?.error ?? 'нет ответа'}`, 'warn'); break; }
      } else {
        c.send({ t: 'FULLSCREEN', on: false });
        await assistClick(c, clickable(btn), 'Apple Pay', 'Нажми «Continue with Pay» — откроется QR для iPhone');
      }
      const got = await waitUntil(() => qrVia(hadFocus) ?? (termsErrorShown() ? 'terms' : null), how === 'human' ? 4000 : 2500, sig);
      if (got === 'terms') { c.log('Apple: «read and accept the terms» — галочка и повтор', 'warn'); await acceptTerms(c, 3000); continue; }
      if (got) { c.log(`QR Apple Pay показан (клик: ${how})`); return got; }
      c.log(`клик ${how}: QR не появился`, 'warn');
      break;
    }
  }
  c.setState('NEED_HUMAN', 'QR Apple Pay не открылся — нажми «Continue with Pay» сам');
  c.needHuman('payment', 'QR Apple Pay не открылся');
  return null;
}

/** QR на экране: ждём номер заказа; QR пропал без заказа → true (открыть ещё раз). */
async function qrLoop(c: Ctl, via: Via): Promise<boolean> {
  const sig = c.signal;
  const ap = c.b?.applePay;
  c.ts.qrShownAt = Date.now();
  c.ts.applePayOpens = (c.ts.applePayOpens ?? 0) + 1;
  void c.save();
  c.setState('WAIT_APPLEPAY', `QR Apple Pay на экране — сканируй iPhone (${c.ts.applePayOpens})`);
  c.overlay.banner(`${payLabel(c)} · сканируй QR телефоном и подтверди`, 'Бот ничего не подтверждает', 'warn');
  c.send({ t: 'PAY_WAIT', kind: 'applepay_qr' });
  watchForOrderNo(c);
  const deadline = (c.ts.payStartedAt ?? Date.now()) + (ap?.timeoutSec ?? 300) * 1000;
  const gone = await waitUntil(() => (via === 'dom' ? !domQr() : document.hasFocus()) ? true : null, Math.max(1000, deadline - Date.now()), sig);
  if (c.ts.state === 'ORDERED') return false;
  if (!gone) {
    c.setState('PAY_TIMEOUT', `Apple Pay: нет номера заказа ${ap?.timeoutSec ?? 300} с`);
    c.send({ t: 'FULLSCREEN', on: false });
    c.needHuman('payment', 'Apple Pay: время вышло');
    return false;
  }
  // оплата могла пройти — номер появляется не сразу
  await sleep(1200, sig);
  if (c.ts.state === 'ORDERED' || (SEL.txtOrderNo.test(document.body?.innerText ?? '') && SEL.txtThanks.test(document.body?.innerText ?? ''))) return false;
  if ((c.ts.applePayOpens ?? 0) > (ap?.reopenTries ?? 3)) {
    c.setState('NEED_HUMAN', `QR закрывался ${c.ts.applePayOpens} раз без заказа — дальше сам`);
    c.send({ t: 'FULLSCREEN', on: false });
    c.needHuman('payment', `QR Apple Pay закрылся ${c.ts.applePayOpens} раз`);
    return false;
  }
  c.log('QR закрылся/истёк без заказа — открываю ещё раз', 'warn');
  return true;
}
