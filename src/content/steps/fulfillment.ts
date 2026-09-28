// Fulfillment: самовывоз, город, магазин, дата, check-in window (§3.6, §7.6).
// timeSlotId/signKey выдаёт сервер — выбор только через UI.
import { SEL } from '../../shared/selectors';
import { storeName } from '../../shared/parts';
import type { Ctl } from '../ctl';
import { assistSelect } from '../assist';
import { orderWindows } from '../slots';
import { submitAndWait } from './submit';
import {
  clickEl, findField, findSelect, isEnabled, isVisible, pickRadio, q, qa,
  setInput, setSelect, sleep, textOf, waitFor, waitForUrl, waitUntil,
} from '../dom';

const NEXT_STEP = /[?&]_s=(PickupContact|Shipping|Billing)/i;
const ANY_ERROR = new RegExp(`${SEL.txtSlotError.source}|${SEL.txtGenericError.source}`, 'i');

export async function fulfillmentStep(c: Ctl): Promise<void> {
  const sig = c.signal;
  const o = c.order!;
  c.setState('FULFILLMENT', 'самовывоз');
  await waitUntil(() => (qa(SEL.segmented).length || q(SEL.city) || q(SEL.storeRadioAny) ? true : null), 12000, sig);

  // 1. «I'll pick it up»
  const pick = qa<HTMLButtonElement>(SEL.segmented).find((b) => SEL.txtPickup.test(textOf(b)));
  if (pick && !pick.classList.contains(SEL.segmentedSelectedClass)) {
    pick.click();
    await waitUntil(() => (pick.classList.contains(SEL.segmentedSelectedClass) || q(SEL.city) || q(SEL.storeRadioAny) ? true : null), 6000, sig);
  }

  // 2. город
  const city = await waitFor<HTMLSelectElement>(SEL.city, 8000, sig);
  if (city) await ensureCity(c, city, o.city);
  else c.log('нет select города — пропускаю', 'warn');

  // 3. список магазинов
  const listed = await waitUntil(() => (qa(SEL.storeRadioAny).length ? true : null), 10000, sig);
  if (!listed) c.log('список магазинов не появился за 10 с', 'warn');

  // 4. магазины по порядку
  if (listed) {
    for (const sid of o.stores) {
      if (await tryStore(c, sid)) return;
    }
  }

  // 5. самовывоза нет
  if (o.deliveryFallback) {
    await deliveryFallback(c);
    return;
  }
  if (o.allowApplePayExpress) {
    c.log('самовывоза нет — allowApplePayExpress: Apple Pay из корзины (доставка)', 'warn');
    c.ts.applePayExpress = true;
    await c.navigate(c.bagUrl(), 'нет самовывоза → Apple Pay Express из корзины');
    return;
  }
  c.setState('STUCK', 'нет самовывоза ни в одном магазине из списка');
  c.alert(`Заказ ${o.id}: нет самовывоза`, `Магазины ${o.stores.join(', ')}: нет свободных окон`);
}

function storeSignature(): string {
  return qa<HTMLInputElement>(SEL.storeRadioAny).map((r) => `${r.value}:${r.disabled ? 0 : 1}`).join(',') + '|' + textOf(q(SEL.storeResults)).length;
}

async function ensureCity(c: Ctl, city: HTMLSelectElement, want: string): Promise<void> {
  const w = want.trim().toLowerCase();
  const opts = Array.from(city.options);
  const opt = opts.find((op) => op.text.trim().toLowerCase() === w || op.value.toLowerCase() === w)
    ?? opts.find((op) => op.text.toLowerCase().includes(w));
  if (!opt) { c.log(`город «${want}» не найден в списке`, 'warn'); return; }
  if (city.value === opt.value) return;
  const before = storeSignature();
  setSelect(city, opt.value);
  await sleep(300, c.signal);
  if (city.value !== opt.value) {
    await assistSelect(c, city, 'Город', `Выбери город ${want}`, () => city.value === opt.value);
  }
  await waitUntil(() => (storeSignature() !== before ? true : null), 4000, c.signal);
}

/** Карточка магазина: предок radio, где ровно один магазин. */
function storeCard(radio: HTMLInputElement): HTMLElement {
  const res = radio.closest<HTMLElement>(SEL.storeResults);
  if (res && res.querySelectorAll(SEL.storeRadioAny).length === 1) return res;
  let el: HTMLElement = radio;
  for (let i = 0; i < 8 && el.parentElement && el.parentElement !== document.body; i++) {
    if (el.parentElement.querySelectorAll(SEL.storeRadioAny).length > 1) break;
    el = el.parentElement;
  }
  return el;
}

function enabledDates(): HTMLInputElement[] {
  return qa<HTMLInputElement>(SEL.dateRadio).filter((d) => !d.disabled);
}

function slotSelect(): HTMLSelectElement | null {
  return findSelect(SEL.slotSelect);
}

async function pickDate(c: Ctl, day: string | null): Promise<{ input: HTMLInputElement; label: string } | null> {
  const dates = await waitUntil(() => { const d = enabledDates(); return d.length ? d : null; }, 5000, c.signal);
  if (!dates) return null;
  const want = day ? String(Number(day)) : null;
  const input = (want && dates.find((d) => String(Number(d.value)) === want)) || dates[0];
  if (want && String(Number(input.value)) !== want) c.log(`дата ${day} недоступна — беру ${input.value}`, 'warn');
  if (!input.checked) pickRadio(input);
  await waitUntil(() => (input.checked ? true : null), 3000, c.signal);
  const label = textOf(input.labels?.[0] ?? input.closest('label')) || input.value;
  return { input, label };
}

/** true — ушли на следующий шаг. */
async function tryStore(c: Ctl, sid: string): Promise<boolean> {
  const sig = c.signal;
  const o = c.order!;
  const radio = q<HTMLInputElement>(SEL.storeRadio(sid));
  const name = storeName(sid);
  if (!radio) { c.log(`${sid} ${name}: нет в списке`); return false; }
  const card = storeCard(radio);
  const cardText = textOf(card);
  if (radio.disabled || SEL.txtUnavailable.test(cardText)) {
    c.log(`${sid} ${name}: ${SEL.txtUnavailable.exec(cardText)?.[0] ?? 'недоступен'} — пропуск`);
    return false;
  }
  c.setState('FULFILLMENT', `магазин ${name}`);
  if (!radio.checked) {
    pickRadio(radio);
    await waitUntil(() => (radio.checked ? true : null), 3000, sig);
    await sleep(250, sig); // даты старого магазина успевают смениться
  }
  let date = await pickDate(c, o.slot.day);
  if (!date) { c.log(`${name}: нет дат за 5 с — следующий магазин`, 'warn'); return false; }
  const sel = await waitUntil(() => { const s = slotSelect(); return s && Array.from(s.options).some((x) => x.value) ? s : null; }, 5000, sig);
  if (!sel) { c.log(`${name}: нет окон check-in — следующий магазин`, 'warn'); return false; }
  const windows = orderWindows(Array.from(sel.options).filter((x) => x.value).map((x) => ({ value: x.value, label: x.text.trim() })), o.slot);
  const limit = Math.min(windows.length, c.cfg.retries.slotsPerStore);
  for (let i = 0; i < limit; i++) {
    const w = windows[i];
    // после ошибки дата/окна могут перерисоваться
    if (!date.input.isConnected || !date.input.checked) {
      date = await pickDate(c, o.slot.day);
      if (!date) return false;
    }
    const s = await waitUntil(() => { const x = slotSelect(); return x && Array.from(x.options).some((op) => op.value === w.value) ? x : null; }, 4000, sig);
    if (!s) { c.log(`окно ${w.label} исчезло`); continue; }
    setSelect(s, w.value);
    await sleep(150, sig);
    let cont = await waitUntil(() => { const b = q(SEL.fulfillmentContinue); return b && isEnabled(b) ? b : null; }, 3000, sig);
    if (s.value !== w.value || !cont) {
      c.log('setSelect окна не принят приложением — ассистент', 'warn');
      await assistSelect(c, s, 'Окно самовывоза', `Выбери окно ${w.label}`, () => !!s.value && isEnabled(q(SEL.fulfillmentContinue)));
      cont = q(SEL.fulfillmentContinue);
      if (!cont) continue;
    }
    const chosen = Array.from(s.options).find((x) => x.value === s.value)?.text.trim() ?? w.label;
    Object.assign(c.ts, { store: sid, slot: s.value, slotLabel: `${date.label} ${chosen}`, slotAt: Date.now() });
    // ошибка общего вида («unexpected error», 12.09.2026) — повторить то же окно, а не отдавать хороший слот
    for (let attempt = 0; attempt <= c.t.checkoutErrorRetries; attempt++) {
      cont = await waitUntil(() => { const b = q(SEL.fulfillmentContinue); return b && isEnabled(b) ? b : null; }, 3000, sig);
      if (!cont) break;
      c.setState('FULFILLMENT', `${name} · ${date.label} ${chosen} → Continue${attempt ? ` (повтор ${attempt})` : ''}`);
      const r = await submitAndWait(c, cont, NEXT_STEP, ANY_ERROR);
      if (r.result === 'next') return true;
      if (r.result === 'error' && !r.generic) { c.log(`окно ${chosen} не принято: ${r.text}`, 'warn'); break; }
      c.log(`Continue: ${r.result === 'error' ? `ошибка общего вида «${r.text}»` : 'нет ответа за 15 с'} — повтор того же окна`, 'warn');
      await sleep(1200, sig);
      if (s.value !== w.value && slotSelect()) { const x = slotSelect()!; setSelect(x, w.value); await sleep(150, sig); }
    }
  }
  c.log(`${name}: ${limit} окон не прошли — следующий магазин`);
  return false;
}

// ---------- фолбэк доставки ----------
async function deliveryFallback(c: Ctl): Promise<void> {
  const sig = c.signal;
  c.setState('FULFILLMENT', 'самовывоза нет — доставка (фолбэк)');
  c.alert(`Заказ ${c.order?.id}: доставка`, 'Самовывоза нет — оформляю доставку');
  const del = qa<HTMLButtonElement>(SEL.segmented).find((b) => SEL.txtDelivered.test(textOf(b)));
  if (del && !del.classList.contains(SEL.segmentedSelectedClass)) del.click();
  const any = await waitFor(SEL.deliveryOption, 8000, sig);
  if (!any) { c.setState('STUCK', 'нет вариантов доставки'); return; }
  const groups = new Map<string, HTMLInputElement[]>();
  for (const r of qa<HTMLInputElement>(SEL.deliveryOption)) {
    const k = r.name || r.getAttribute('data-autom') || 'g';
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  for (const rs of groups.values()) {
    if (!rs.some((r) => r.checked)) {
      const first = rs.find((r) => !r.disabled);
      if (first) pickRadio(first);
    }
  }
  const cont = await waitUntil(() => { const b = q(SEL.fulfillmentContinue); return b && isEnabled(b) ? b : null; }, 5000, sig);
  if (!cont) { c.setState('STUCK', 'Continue to Shipping Address не активна'); return; }
  clickEl(cont);
  if (!(await waitForUrl(/_s=Shipping/i, 15000, sig))) c.setState('STUCK', 'не перешли на Shipping');
}

export async function shippingStep(c: Ctl): Promise<void> {
  const sig = c.signal;
  const o = c.order!;
  c.setState('SHIPPING', 'адрес доставки');
  await waitFor(SEL.firstName, 10000, sig);
  const fields: [string, string][] = [
    [SEL.firstName, o.contact.firstName],
    [SEL.lastName, o.contact.lastName],
    [SEL.shipStreet, o.address.street],
    [SEL.shipStreet2, o.address.area],
    [SEL.email, o.contact.email],
    [SEL.phone, o.contact.phone],
  ];
  for (const [sel, val] of fields) {
    const f = findField(sel);
    if (f && f.value !== val) setInput(f, val);
  }
  const citySel = findSelect(SEL.shipCity);
  if (citySel) {
    const opt = Array.from(citySel.options).find((x) => x.text.trim().toLowerCase() === o.address.city.toLowerCase());
    if (opt && citySel.value !== opt.value) setSelect(citySel, opt.value);
  } else {
    const f = findField(SEL.shipCity);
    if (f && f.value !== o.address.city) setInput(f, o.address.city);
  }
  const btn = await waitUntil(() => { const b = q(SEL.shippingContinue); return b && isEnabled(b) && isVisible(b) ? b : null; }, 5000, sig);
  if (!btn) { c.setState('STUCK', 'нет Continue на Shipping'); return; }
  const ANY = new RegExp(`${SEL.txtContactError.source}|${SEL.txtGenericError.source}`, 'i');
  let msg = '';
  for (let attempt = 0; attempt <= c.t.checkoutErrorRetries; attempt++) {
    const r = await submitAndWait(c, btn, /_s=Billing/i, ANY);
    if (r.result === 'next') return;
    msg = r.text;
    if (r.result === 'error' && !r.generic) break;
    c.log(`Shipping Continue: ${msg} — повтор`, 'warn');
    await sleep(1200, sig);
  }
  c.setState('NEED_HUMAN', `Shipping: ${msg} — поправь поле и нажми Continue`);
  c.alert(`Заказ ${o.id}: адрес`, msg);
  if (await waitForUrl(/_s=Billing/i, 600_000, sig)) c.log('Billing после ручного исправления адреса');
}
