// Оплата (§3.8, §7.7) — граница автоматизации.
// Расширение: выбирает способ, заполняет карту из конфига (если задана), нажимает «Review Your Order»
// (autoReview), для Apple Pay пробует открыть лист с кодом. Place Order / подтверждение Apple Pay — только человек.
import { SEL } from '../../shared/selectors';
import { storeName } from '../../shared/parts';
import { isMockBase } from '../../shared/config';
import type { Ctl } from '../ctl';
import { assistClick } from '../assist';
import { clickEl, clickable, isChecked, pickRadio, qa, resolveInput, setInput, setSelect, sleep, textOf, waitForUrl, waitUntil } from '../dom';
import { billingRoot, findEl, findField, findSelect, waitEl, waitEnabled, type Key } from '../find';

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
  await waitUntil(() => findEl('payCard') || findEl('payApplePay'), c.t.checkoutPageWaitMs, sig);
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
    const num = await waitCardFields(c, card);
    if (num) {
      await fillCard(c, num);
      await fillBillingAddress(c);
    } else {
      const ap = o.cardFallback === 'applepay' ? findEl('payApplePay') : null;
      if (ap) {
        c.log(`поля карты не появились за ${c.t.cardWaitMs / 1000} с — переключаюсь на Apple Pay (cardFallback=applepay)`, 'warn');
        pickRadio(ap);
        method = 'applepay';
        await sleep(300, sig);
      } else {
        c.log(`поля карты не появились за ${c.t.cardWaitMs / 1000} с — введи карту сам`, 'warn');
        c.overlay.banner(`${payLabel(c)} · поля карты не загрузились`, 'Выбери способ оплаты и введи карту сам', 'warn');
      }
    }
  }
  c.ts.payMethod = method;
  c.ts.billingAt = Date.now();
  c.setState('PAY_QUEUE', 'в очереди на оплату');
  c.send({ t: 'BILLING_READY', store: c.ts.store ?? '', slot: c.ts.slot ?? '', slotLabel: c.ts.slotLabel ?? '', method, price: c.ts.price, cardFilled: !!c.ts.cardFilled });
  showPayBanner(c);
}

/**
 * Блок карты у Apple появляется через несколько секунд после выбора «Credit or Debit Card» (live 30.09), на дропе —
 * заметно дольше. Ждём до timing.cardWaitMs (90 с, FLEET-SPEC §10): каждые 5 с проверяем, что radio всё ещё
 * выбран (иначе кликаем снова), каждые 15 с пишем в лог, чтобы было видно, что вкладка не зависла.
 */
async function waitCardFields(c: Ctl, radio: HTMLElement | null): Promise<HTMLInputElement | null> {
  const t0 = Date.now();
  const total = Math.max(1000, c.t.cardWaitMs);
  let lastLog = t0;
  let num: HTMLInputElement | null = null;
  while (!num) {
    const left = total - (Date.now() - t0);
    if (left <= 0) break;
    num = await waitUntil(() => findField('cardNumber'), Math.min(5000, left), c.signal);
    if (num) break;
    const r = radio ?? findEl('payCard');
    if (r && !isChecked(r)) {
      c.log('radio «Credit or Debit Card» не выбран — повторный клик', 'warn');
      pickRadio(r);
    }
    if (Date.now() - lastLog >= 15000) {
      lastLog = Date.now();
      c.setState('BILLING', `ждём поля карты ${Math.round((Date.now() - t0) / 1000)} с из ${Math.round(total / 1000)}`);
      c.log(`поля карты ещё не появились (${Math.round((Date.now() - t0) / 1000)} с)`);
    }
  }
  const dt = Date.now() - t0;
  if (num && dt > 1500) c.log(`поля карты появились через ${(dt / 1000).toFixed(1)} с`);
  return num;
}

/** Карта из конфига: номер, срок, CVV, имя. Данные не логируются; в лог — только последние 4 цифры. */
async function fillCard(c: Ctl, num: HTMLInputElement): Promise<void> {
  const card = c.order?.card;
  num.scrollIntoView({ block: 'center' });
  if (!card?.number) { c.log('карта в конфиге не задана — вводит человек (курсор в поле карты)'); num.focus(); return; }
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

/**
 * Billing Address при оплате картой (18 Pro, live 30.09): First/Last Name, Street Address, Area, City обязательны,
 * Title и Town — нет. Без адреса «Review Your Order» отвечает «Please complete this mandatory field».
 */
async function fillBillingAddress(c: Ctl): Promise<void> {
  const o = c.order!;
  const b = o.billing;
  const street = b.street || o.address.street;
  const area = b.area || o.address.area;
  const city = b.city || o.address.city;
  const root = billingRoot();
  const first = await waitUntil(() => findField('billFirstName', root) ?? findField('billStreet', root), 3000, c.signal);
  if (!first) { c.log('Billing Address: полей адреса нет — Apple не спросил адрес плательщика'); return; }
  if (!street || !area) {
    c.log('Billing Address нужен для карты, но «Плательщик: улица / Area» в настройках пусты — заполни адрес сам', 'warn');
    c.overlay.banner(`${payLabel(c)} · заполни Billing Address`, 'В настройках пусто: Плательщик: улица / Area', 'warn');
    return;
  }
  const done: string[] = [];
  const missed: string[] = [];
  const fields: [Key, string, string][] = [
    ['billFirstName', b.firstName || o.contact.firstName, 'имя'],
    ['billLastName', b.lastName || o.contact.lastName, 'фамилия'],
    ['billStreet', street, 'улица'],
    ['billArea', area, 'Area'],
    ['billTown', b.town, 'Town'],
  ];
  for (const [key, val, label] of fields) {
    if (!val) continue;
    const f = findField(key, root);
    if (!f) { missed.push(label); continue; }
    if (f.value !== val) setInput(f, val);
    await sleep(60, c.signal);
    (f.value === val ? done : missed).push(label);
  }
  const selects: [Key, string, string][] = [['billTitle', b.title, 'Title'], ['billCity', city, 'город']];
  for (const [key, val, label] of selects) {
    if (!val) continue;
    const s = findSelect(key, root);
    if (!s) { if (key === 'billCity') missed.push(label); continue; }
    const opt = Array.from(s.options).find((x) => x.text.trim().toLowerCase() === val.toLowerCase() || x.value.toLowerCase() === val.toLowerCase());
    if (!opt) { missed.push(`${label} (нет варианта «${val}»)`); continue; }
    if (s.value !== opt.value) setSelect(s, opt.value);
    await sleep(60, c.signal);
    (s.value === opt.value ? done : missed).push(label);
  }
  c.log(`адрес плательщика: заполнено ${done.join(', ') || '—'}${missed.length ? `; не удалось: ${missed.join(', ')}` : ''}`, missed.length ? 'warn' : 'info');
  if (missed.length) c.overlay.banner(`${payLabel(c)} · допиши в Billing Address: ${missed.join(', ')}`, 'Остальное расширение заполнило', 'warn');
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
    const what = c.ts.payMethod === 'applepay' ? 'Apple Pay: код телефоном → подтверди'
      : c.ts.placeOrderTried ? 'Place Order нажат — подтверди оплату в приложении банка'
      : c.order?.autoPlaceOrder ? 'Place Order нажмёт расширение → подтверди в приложении банка'
      : 'нажми Place Order';
    c.overlay.banner(`${label} · ${what}`, `${c.ts.placeOrderTried ? 'Расширение больше ничего не нажимает. ' : ''}${dup}`, 'warn');
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
  if (REVIEW_URL.test(location.href)) { await onReviewTurn(c); return; }
  if (!c.order?.autoReview) {
    if (c.ts.payMethod === 'manual') { const f = findField('cardNumber'); if (f && !c.ts.cardFilled) f.focus(); }
    return;
  }
  const btn = await waitEnabled('reviewButton', c.t.checkoutPageWaitMs, sig);
  if (!btn) { c.log('кнопка Review Your Order не активна — дальше человек', 'warn'); return; }
  if (findEl('termsCheckbox')) await acceptTerms(c, 1000); // иногда условия уже на Billing
  c.setState('PAYING', 'Review Your Order');
  clickEl(btn);
  const went = await waitForUrl(REVIEW_URL, c.t.continueWaitMs, sig);
  // смена _s=Review → watchRoute перезапустит диспетчер (reviewStep → onReviewTurn) с новым signal;
  // продолжать отсюда нельзя: этот шаг вот-вот прервут, и клик Apple Pay оборвался бы на полпути
  if (went) return;
  {
    const err = /Please\s[^.\n]{3,120}|unexpected error|something went wrong/i.exec(document.body?.innerText ?? '')?.[0];
    c.setState('PAYING', `Review не открылся${err ? `: ${err}` : ''} — проверь форму и нажми Review сам`);
    c.overlay.banner(`${payLabel(c)} · проверь форму оплаты и нажми Review Your Order`, err ?? 'Расширение дальше не жмёт', 'warn');
  }
}

/** Центр кнопки Apple Pay в координатах viewport — для настоящего клика через chrome.debugger из SW (FLEET-SPEC §8). */
export function applePayCoords(): { x: number; y: number } | null {
  const btn = findEl('applePayButton');
  if (!btn) return null;
  const r = clickable(btn).getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** Лист Apple Pay (QR) открыт: это окно браузера поверх страницы — страница теряет фокус. В mock — видимый #applepay-sheet. */
function sheetOpen(c: Ctl): boolean {
  if (isMockBase(c.base)) { const el = document.getElementById('applepay-sheet'); return !!el && !el.hidden; }
  return !document.hasFocus();
}

function waitSheet(c: Ctl, ms: number): Promise<boolean> {
  return waitUntil(() => (sheetOpen(c) ? true : null), ms, c.signal).then((x) => !!x);
}

/**
 * Apple Pay в Chrome: лист с кодом для iPhone открывает браузер, и ему нужен настоящий клик — программный клик
 * из content script Chrome отвергает (правило браузера, не защита Apple). Цепочка (FLEET-SPEC §8):
 * 1) программный клик (вдруг пройдёт), 2) один настоящий клик через chrome.debugger из SW, 3) подсветка — жмёт человек.
 * Лист закрылся без номера заказа → повтор через 5 с, до applePayRetries. Расширение ничего не подтверждает.
 */
async function tryApplePay(c: Ctl): Promise<void> {
  if (c.ts.payMethod !== 'applepay' || c.ts.applePayTried) return;
  const btn = await waitUntil(() => findEl('applePayButton'), 5000, c.signal);
  if (!btn) { c.log('кнопка Apple Pay на Review не найдена — жми сам', 'warn'); showPayBanner(c); return; }
  await acceptTerms(c, 2500); // обязательно до клика по оплате — иначе «Please read and accept the terms & conditions»
  if (c.ts.applePayTried) return; // параллельный вызов уже кликнул
  // флаг — непосредственно перед кликом: если шаг прервут раньше (смена маршрута), следующий вызов попробует снова
  c.ts.applePayTried = true;
  c.ts.applePayTries = (c.ts.applePayTries ?? 0) + 1;
  c.ts.applePayAt = Date.now();
  void c.save();
  btn.scrollIntoView({ block: 'center' });
  clickEl(btn);
  await sleep(900, c.signal);
  if (termsErrorShown()) {
    c.log('Apple: «read and accept the terms» — ставлю галочку и жму Apple Pay ещё раз', 'warn');
    await acceptTerms(c, 3000);
    clickEl(btn);
    await sleep(900, c.signal);
  }
  let opened = await waitSheet(c, 1500);
  let how = 'программный клик';
  if (!opened && c.order?.applePayClick === 'debugger') {
    how = 'debugger-клик';
    const p = applePayCoords();
    if (!p) c.log('кнопка Apple Pay не видна — debugger-клик невозможен', 'warn');
    else {
      c.setState('PAYING', 'Apple Pay: настоящий клик через debugger');
      const r = await c.request({ t: 'APPLEPAY_CLICK_REQ', x: p.x, y: p.y }, 'APPLEPAY_CLICK_DONE', 10000);
      if (!r) c.log('SW не ответил на запрос debugger-клика', 'warn');
      else if (!r.ok) c.log(`debugger-клик не выполнен: ${r.error ?? ''}`, 'warn');
      opened = await waitSheet(c, 3000);
      if (!opened && termsErrorShown() && (await acceptTerms(c, 3000))) {
        const p2 = applePayCoords() ?? p;
        await c.request({ t: 'APPLEPAY_CLICK_REQ', x: p2.x, y: p2.y }, 'APPLEPAY_CLICK_DONE', 10000);
        opened = await waitSheet(c, 3000);
      }
    }
  }
  if (opened) {
    c.log(`лист Apple Pay открыт (${how}, попытка ${c.ts.applePayTries}) — сканируй код телефоном`);
    c.setState('PAYING', 'Apple Pay: лист открыт — сканируй код телефоном');
    c.overlay.banner(`${payLabel(c)} · сканируй код телефоном и подтверди`, 'Расширение ничего не подтверждает', 'warn');
    void watchSheet(c).catch(() => {});
    return;
  }
  c.log(`лист Apple Pay не открылся (${how}) — нужен клик человека`, 'warn');
  await assistClick(c, clickable(btn), 'Apple Pay', 'Нажми Apple Pay — откроется код для iPhone');
  c.setState('PAYING', 'Apple Pay: сканируй код телефоном');
  showPayBanner(c);
}

/** Лист закрылся без номера заказа (отменили / QR истёк): через 5 с ещё попытка, пока не исчерпаны applePayRetries. */
async function watchSheet(c: Ctl): Promise<void> {
  const sig = c.signal;
  let closedSince: number | null = null;
  for (;;) {
    await sleep(500, sig);
    if (c.ts.state === 'ORDERED' || !REVIEW_URL.test(location.href)) return;
    if (sheetOpen(c)) { closedSince = null; continue; }
    closedSince ??= Date.now();
    if (Date.now() - closedSince >= 2000) break; // 2 с подряд «страница в фокусе» — лист закрыт
  }
  const tries = c.ts.applePayTries ?? 1;
  const max = c.order?.applePayRetries ?? 0;
  if (tries > max) {
    c.log(`лист Apple Pay закрылся без заказа, повторы исчерпаны (${max}) — нажми Apple Pay сам`, 'warn');
    c.setState('PAYING', 'Apple Pay: лист закрылся — нажми Apple Pay сам');
    const btn = findEl('applePayButton');
    if (btn) await assistClick(c, clickable(btn), 'Apple Pay', 'Нажми Apple Pay — откроется код для iPhone');
    showPayBanner(c);
    return;
  }
  c.log(`лист Apple Pay закрылся без заказа — повтор через 5 с (${tries} из ${max})`, 'warn');
  c.setState('PAYING', `Apple Pay: лист закрылся — повтор через 5 с (${tries}/${max})`);
  await sleep(5000, sig);
  if (c.ts.state === 'ORDERED') return;
  c.ts.applePayTried = false;
  await tryApplePay(c);
}

export function reviewStep(c: Ctl): void {
  if (c.ts.state === 'ORDERED') return;
  c.setState('REVIEW', c.ts.payMethod === 'applepay' ? 'Apple Pay (человек)' : 'ждём Place Order (человек)');
  showPayBanner(c);
  watchForOrderNo(c);
  // галочка Terms & Conditions — при любом способе оплаты, до того как человек/расширение нажмёт оплату
  void (async () => { await acceptTerms(c, 4000); if (c.ts.payTurn) await onReviewTurn(c); })().catch(() => {});
}

/** Наш ход на Review: Apple Pay — открыть лист; карта с autoPlaceOrder — нажать Place Order (один раз). */
async function onReviewTurn(c: Ctl): Promise<void> {
  if (c.ts.payMethod === 'applepay') await tryApplePay(c);
  else if (c.order?.autoPlaceOrder) await tryPlaceOrder(c);
}

/**
 * Place Order при оплате картой (владелец, 30.09): банк требует подтверждение в приложении (3-D Secure) — его делает
 * человек. Один клик за всё время жизни вкладки (флаг хранится в состоянии вкладки и переживает перезагрузку):
 * ошибка после Place Order → заказ мог пройти (12.09 дубли), повторно не жмём, человек проверяет почту/номер.
 * Исключение — ошибка про галочку условий: заказ не отправлялся, ставим галочку и жмём ещё раз.
 */
async function tryPlaceOrder(c: Ctl): Promise<void> {
  if (c.ts.payMethod !== 'manual' || !c.order?.autoPlaceOrder || c.ts.placeOrderTried) return;
  c.ts.placeOrderTried = true; // синхронно, до первого await — второй вызов не должен нажать ещё раз
  c.ts.placeOrderAt = Date.now();
  void c.save();
  const btn = await waitEnabled('placeOrderButton', 8000, c.signal);
  if (!btn) { c.log('кнопка Place Order не найдена или не активна — нажми сам', 'warn'); c.ts.placeOrderTried = false; showPayBanner(c); return; }
  const terms = await acceptTerms(c, 3000);
  if (!terms && findEl('termsCheckbox')) { c.log('Place Order не нажимаю: галочка условий не стоит — поставь и нажми сам', 'warn'); c.ts.placeOrderTried = false; showPayBanner(c); return; }
  c.log('Place Order нажат (autoPlaceOrder) — подтверждение банка (3-D Secure) за тобой');
  clickEl(btn);
  c.setState('REVIEW', 'Place Order нажат — подтверди оплату в приложении банка');
  c.alert(`Заказ ${c.order.id}: подтверди оплату`, 'Place Order нажат — подтверждение в приложении банка');
  showPayBanner(c);
  await sleep(1500, c.signal);
  if (termsErrorShown()) {
    c.log('Apple: «read and accept the terms» после Place Order — заказ не отправлялся; ставлю галочку и жму ещё раз', 'warn');
    if (await acceptTerms(c, 3000)) { clickEl(btn); await sleep(1500, c.signal); }
  }
  const err = qa<HTMLElement>('[role="alert"], [class*="error" i]').map(textOf).filter((t) => t && !SEL.txtTermsError.test(t)).join(' | ').slice(0, 200);
  if (err) {
    c.log(`после Place Order: ${err} — повторно не нажимаю; проверь почту и номер заказа, потом решай`, 'warn');
    c.overlay.banner(`${payLabel(c)} · после Place Order: ${err.slice(0, 80)}`, 'Расширение повторно не жмёт: сначала почта и номер заказа, заказ мог пройти', 'warn');
  }
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

/** Ошибка про галочку условий — только в блоках ошибок, не по всему тексту страницы (label галочки похож на неё). */
function termsErrorShown(): boolean {
  return qa<HTMLElement>('[role="alert"], [class*="error" i]').some((el) => SEL.txtTermsError.test(textOf(el)));
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
