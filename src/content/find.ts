// Устойчивый поиск элементов: сначала селектор из ТЗ, затем запасные селекторы, затем текст/атрибуты.
// Если Apple переименует data-autom, кнопка всё равно найдётся по подписи «Add to Bag», «Continue as Guest»…
// Каждое срабатывание запасного пути пишется в лог один раз на страницу — после дропа видно, что менять в SEL.
import { SEL } from '../shared/selectors';
import { isVisible, qa, resolveInput, textOf, waitUntil } from './dom';

export interface Spec {
  sel: string;                 // основной селектор (из SEL)
  alt?: string[];              // запасные селекторы
  text?: RegExp;               // подпись видимой кнопки / label
  attr?: RegExp;               // name / autocomplete / placeholder / aria-label / id поля
  kind?: 'button' | 'radio' | 'field' | 'select' | 'checkbox' | 'any';
}

export const F = {
  // конфигурация
  addToBag: { sel: SEL.addToBag, alt: ['button[name="add-to-cart"]', 'button[value="add-to-cart"]', 'form button[type="submit"][data-autom*="cart" i]'], text: /^add to bag$/i, kind: 'button' },
  continueDisabled: { sel: SEL.continueDisabled, alt: ['button[data-autom*="continueButton" i]'], kind: 'button' },
  noTradeIn: { sel: SEL.noTradeIn, alt: ['input[value="noTradeIn"]', '[data-autom*="noTradeIn" i]'], text: /^no trade.?in\b/i, kind: 'radio' },
  noAppleCare: { sel: SEL.noAppleCare, alt: ['[data-autom*="noapplecare" i]', 'input[name*="applecare" i][value="none"]'], text: /^no applecare/i, kind: 'radio' },
  // корзина
  bagCheckout: { sel: SEL.bagCheckout, alt: ['button[data-autom*="checkout" i]:not([data-autom*="apple" i])'], text: /^check ?out$/i, kind: 'button' },
  bagApplePay: { sel: SEL.bagApplePay, alt: ['button[data-autom*="apple-pay" i]', 'button[aria-label*="Apple Pay" i]'], text: /apple ?pay/i, kind: 'button' },
  bagItemRemove: { sel: SEL.bagItemRemove, alt: ['button[data-autom*="remove" i]'], text: /^remove$/i, kind: 'button' },
  bagItemName: { sel: SEL.bagItemName, alt: ['[data-autom*="item-name" i]', '[class*="item-name" i]', '[class*="iteminfo" i] h2', '[class*="bag-item" i] h2'], kind: 'any' },
  bagItemQty: { sel: SEL.bagItemQty, alt: ['select[data-autom*="quantity" i]', 'select[aria-label*="quantity" i]', 'select[name*="qty" i]', 'select[name*="quantity" i]'], kind: 'select' },
  bagTotal: { sel: SEL.bagTotal, alt: ['[data-autom*="total" i]', '[class*="bag-total" i]'], kind: 'any' },
  // вход
  guest: { sel: SEL.guest, alt: ['button[data-autom*="guest" i]'], text: /continue as guest|guest checkout/i, kind: 'button' },
  // fulfillment
  city: { sel: SEL.city, alt: ['select[name*="city" i]', 'select[autocomplete="address-level2"]', 'select[data-autom*="city" i]'], attr: /city/i, kind: 'select' },
  storeRadioAny: { sel: SEL.storeRadioAny, alt: ['input[type="radio"][name*="store" i]', 'input[type="radio"][data-autom*="store" i]'], kind: 'radio' },
  dateRadio: { sel: SEL.dateRadio, alt: ['input[type="radio"][name*="date" i]', 'input[type="radio"][name*="day" i]'], kind: 'radio' },
  slotSelect: { sel: SEL.slotSelect, alt: ['select[data-autom*="window" i]', 'select[data-autom*="slot" i]', 'select[name*="time" i]', 'select[name*="slot" i]'], attr: /window|time ?slot|check.?in/i, kind: 'select' },
  fulfillmentContinue: { sel: SEL.fulfillmentContinue, alt: ['button[data-autom*="fulfillment" i][data-autom*="continue" i]'], text: /^continue to (pickup|shipping)/i, kind: 'button' },
  deliveryOption: { sel: SEL.deliveryOption, alt: ['input[type="radio"][name*="shipping" i]', 'input[type="radio"][name*="delivery" i]'], kind: 'radio' },
  shippingContinue: { sel: SEL.shippingContinue, alt: ['button[data-autom*="shipping" i][data-autom*="continue" i]'], text: /^continue to payment/i, kind: 'button' },
  // контакты
  selfPickup: { sel: SEL.selfPickup, alt: ['input[value="SELF"]', '[data-autom*="selfPickup" i]'], text: /^i.ll pick it up|myself/i, kind: 'radio' },
  firstName: { sel: SEL.firstName, alt: ['input[autocomplete="given-name"]', 'input[name*="firstName" i]'], attr: /first ?name/i, kind: 'field' },
  lastName: { sel: SEL.lastName, alt: ['input[autocomplete="family-name"]', 'input[name*="lastName" i]'], attr: /last ?name|surname/i, kind: 'field' },
  email: { sel: SEL.email, alt: ['input[type="email"]', 'input[autocomplete="email"]', 'input[name*="email" i]'], attr: /e-?mail/i, kind: 'field' },
  phone: { sel: SEL.phone, alt: ['input[type="tel"]', 'input[autocomplete="tel"]', 'input[name*="phone" i]', 'input[name*="mobile" i]'], attr: /phone|mobile/i, kind: 'field' },
  contactContinue: { sel: SEL.contactContinue, alt: ['button[data-autom*="continue" i]'], text: /^continue to payment/i, kind: 'button' },
  // доставка
  shipStreet: { sel: SEL.shipStreet, alt: ['input[autocomplete="address-line1"]', 'input[name*="street" i]:not([name*="2"])'], attr: /^street|address line 1|address$/i, kind: 'field' },
  shipStreet2: { sel: SEL.shipStreet2, alt: ['input[autocomplete="address-line2"]', 'input[name*="street2" i]', 'input[name*="area" i]'], attr: /area|address line 2|street ?2/i, kind: 'field' },
  shipCity: { sel: SEL.shipCity, alt: ['[autocomplete="address-level2"]', '[name*="city" i]'], attr: /city/i, kind: 'any' },
  // оплата
  payCard: { sel: SEL.payCard, alt: ['input[value="CREDIT"]', '[data-autom*="billingOptions-CREDIT" i]', 'input[name*="billing" i][value*="CARD" i]'], text: /credit|debit|card/i, kind: 'radio' },
  // подпись radio на живом Billing (18 Pro): логотип-картинка + «Pay» — в тексте только «Pay»
  payApplePay: { sel: SEL.payApplePay, alt: ['input[value="APPLE_PAY"]', '[data-autom*="billingOptions-APPLE" i]'], text: /apple ?pay|^(\uF8FF ?)?pay$/i, kind: 'radio' },
  cardNumber: { sel: SEL.cardNumberFocusOnly, alt: ['input[autocomplete="cc-number"]', 'input[name*="cardNumber" i]', 'input[name*="card-number" i]'], attr: /card ?number/i, kind: 'field' },
  cardExpiry: { sel: '[data-autom="expiration-input"]', alt: ['input[autocomplete="cc-exp"]', 'input[name*="expir" i]'], attr: /expir|mm ?\/ ?yy/i, kind: 'field' },
  cardCvv: { sel: '[data-autom="security-code-input"]', alt: ['input[autocomplete="cc-csc"]', 'input[name*="cvv" i]', 'input[name*="securityCode" i]', 'input[name*="cvc" i]'], attr: /cvv|cvc|security ?code/i, kind: 'field' },
  cardName: { sel: '[data-autom="form-field-nameOnCard"]', alt: ['input[autocomplete="cc-name"]', 'input[name*="nameOnCard" i]', 'input[name*="cardholder" i]'], attr: /name on card|cardholder/i, kind: 'field' },
  // адрес плательщика (Billing Address при оплате картой; 18 Pro, live 30.09: Title, First/Last Name, Street Address, Area, Town (optional), City)
  billTitle: { sel: '[data-autom="form-field-title"]', alt: ['select[name*="billing" i][name*="title" i]', 'select[name$="title" i]', 'select[name$=".title" i]'], attr: /\btitle\b/i, kind: 'select' },
  billFirstName: { sel: SEL.firstName, alt: ['input[name*="billing" i][name*="firstName" i]', 'input[name*="firstName" i]', 'input[autocomplete="given-name"]'], attr: /first ?name/i, kind: 'field' },
  billLastName: { sel: SEL.lastName, alt: ['input[name*="billing" i][name*="lastName" i]', 'input[name*="lastName" i]', 'input[autocomplete="family-name"]'], attr: /last ?name|surname/i, kind: 'field' },
  billStreet: { sel: SEL.shipStreet, alt: ['input[name*="billing" i][name*="street" i]:not([name*="2"]):not([name*="3"])', 'input[autocomplete="address-line1"]', 'input[name*="street" i]:not([name*="2"]):not([name*="3"])'], attr: /^street|street address|address line 1/i, kind: 'field' },
  billArea: { sel: SEL.shipStreet2, alt: ['input[name*="billing" i][name*="street2" i]', 'input[name*="area" i]', 'input[name*="street2" i]', 'input[name*="district" i]', 'input[autocomplete="address-line2"]'], attr: /\barea\b|address line 2/i, kind: 'field' },
  billTown: { sel: '[data-autom="form-field-street3"]', alt: ['input[name*="billing" i][name*="street3" i]', 'input[name*="town" i]', 'input[name*="street3" i]', 'input[autocomplete="address-line3"]'], attr: /\btown\b/i, kind: 'field' },
  billCity: { sel: SEL.shipCity, alt: ['select[name*="billing" i][name*="city" i]', 'select[name*="city" i]', 'select[autocomplete="address-level2"]', 'select[data-autom*="city" i]'], attr: /\bcity\b/i, kind: 'select' },
  reviewButton: { sel: SEL.reviewButtonObserveOnly, alt: ['button[data-autom*="review" i]'], text: /^review your order/i, kind: 'button' },
  // Review (18 Pro, live): кнопка «Continue with Pay» (логотип Apple — картинка, в тексте его нет)
  applePayButton: { sel: '[data-autom="apple-pay-button"]', alt: ['apple-pay-button', 'button[data-autom*="apple-pay" i]', 'button[aria-label*="Apple Pay" i]', '[class*="apple-pay-button" i]', 'button[class*="applepay" i]'], text: /^(pay with |continue with |buy with )?(apple ?|\uF8FF ?)?pay$/i, kind: 'button' },
  // Review: «I have read, understand, and agree to the Terms & Conditions…» — без галочки Apple не пускает к оплате
  termsCheckbox: { sel: '[data-autom*="terms" i] input[type="checkbox"], input[type="checkbox"][data-autom*="terms" i]', alt: ['input[type="checkbox"][name*="terms" i]', 'input[type="checkbox"][id*="terms" i]', 'input[type="checkbox"][name*="agree" i]', 'input[type="checkbox"][id*="agree" i]'], text: /terms|agree/i, kind: 'checkbox' },
} satisfies Record<string, Spec>;

export type Key = keyof typeof F;

const reported = new Set<string>();
let onFallback: (key: Key, how: string) => void = () => {};
export function setFallbackReporter(fn: (key: Key, how: string) => void): void { onFallback = fn; }

function report(key: Key, how: string): void {
  if (reported.has(key)) return;
  reported.add(key);
  onFallback(key, how);
}

function attrText(el: Element): string {
  const e = el as HTMLInputElement;
  const label = e.labels?.[0] ? textOf(e.labels[0]) : '';
  return [e.name, e.getAttribute('autocomplete'), e.getAttribute('placeholder'), e.getAttribute('aria-label'), e.id, label].filter(Boolean).join(' | ');
}

/** Все кандидаты для ключа: селектор → запасные селекторы → текст/атрибуты. */
export function findAll(key: Key, root: ParentNode = document): HTMLElement[] {
  const spec: Spec = F[key];
  let els = qa<HTMLElement>(spec.sel, root);
  if (els.length) return els;
  for (const a of spec.alt ?? []) {
    els = qa<HTMLElement>(a, root);
    if (els.length) { report(key, `запасной селектор ${a}`); return els; }
  }
  if (spec.text && (spec.kind === 'button' || spec.kind === 'any')) {
    els = qa<HTMLElement>('button, a, [role="button"], input[type="submit"], input[type="button"]', root)
      .filter((b) => isVisible(b) && [textOf(b), (b as HTMLInputElement).value, b.getAttribute('aria-label')].some((t) => !!t && spec.text!.test(t)));
    if (els.length) { report(key, `текст ${spec.text}`); return els; }
  }
  if (spec.text && spec.kind === 'checkbox') {
    // сам input Apple прячет (opacity:0) — ищем по подписи label / соседнему тексту / атрибутам, видимость не проверяем
    els = qa<HTMLInputElement>('input[type="checkbox"]', root).filter((i) => {
      const label = i.labels?.[0] ?? i.closest('label');
      const near = i.parentElement?.parentElement ?? i.parentElement;
      return spec.text!.test(textOf(label)) || spec.text!.test(textOf(near).slice(0, 400)) || spec.text!.test(attrText(i));
    });
    if (els.length) { report(key, `подпись чекбокса ${spec.text}`); return els; }
  }
  if (spec.text && spec.kind === 'radio') {
    els = qa<HTMLLabelElement>('label', root).filter((l) => isVisible(l) && spec.text!.test(textOf(l)));
    if (els.length) { report(key, `подпись ${spec.text}`); return els; }
  }
  if (spec.attr && (spec.kind === 'field' || spec.kind === 'select' || spec.kind === 'any')) {
    const tags = spec.kind === 'field' ? 'input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), textarea' : spec.kind === 'select' ? 'select' : 'input:not([type="hidden"]), select, textarea';
    els = qa<HTMLElement>(tags, root).filter((e) => spec.attr!.test(attrText(e)));
    if (els.length) { report(key, `атрибуты ${spec.attr}`); return els; }
  }
  return [];
}

/** Контейнер «Billing Address» на странице оплаты; если заголовка нет — вся страница. */
export function billingRoot(): ParentNode {
  const h = qa<HTMLElement>('h1, h2, h3, h4, h5, legend, [class*="heading" i], [class*="title" i]').find((e) => /^billing address/i.test(textOf(e)));
  let node: HTMLElement | null = h?.parentElement ?? null;
  while (node && node !== document.body && !node.querySelector('input:not([type="hidden"]), select')) node = node.parentElement;
  return node ?? document;
}

export function waitEl(key: Key, timeout: number, signal?: AbortSignal, root: ParentNode = document): Promise<HTMLElement | null> {
  return waitUntil(() => findEl(key, root), timeout, signal);
}

export function waitEnabled(key: Key, timeout: number, signal?: AbortSignal): Promise<HTMLElement | null> {
  return waitUntil(() => { const b = findEl(key); return b && isEnabledEl(b) ? b : null; }, timeout, signal);
}

function isEnabledEl(el: Element): boolean {
  const b = el as HTMLButtonElement;
  return !b.disabled && el.getAttribute('aria-disabled') !== 'true' && !el.classList.contains('disabled');
}

export function findEl(key: Key, root: ParentNode = document): HTMLElement | null {
  return findAll(key, root)[0] ?? null;
}

/** Поле ввода: элемент с data-autom может быть обёрткой вокруг input. */
export function findField(key: Key, root: ParentNode = document): HTMLInputElement | null {
  for (const el of findAll(key, root)) {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el as HTMLInputElement;
    const inner = el.querySelector<HTMLInputElement>('input:not([type="hidden"]), textarea');
    if (inner) return inner;
  }
  return null;
}

export function findSelect(key: Key, root: ParentNode = document): HTMLSelectElement | null {
  for (const el of findAll(key, root)) {
    if (el instanceof HTMLSelectElement) return el;
    const inner = el.querySelector('select');
    if (inner) return inner;
  }
  return null;
}

/** Radio по значению (магазин по коду) или по подписи (название магазина). */
export function findRadio(key: Key, value: string, labelText?: RegExp, root: ParentNode = document): HTMLInputElement | null {
  const all = findAll(key, root).map((el) => resolveInput(el)).filter((x): x is HTMLInputElement => !!x);
  const byValue = all.find((r) => r.value === value);
  if (byValue) return byValue;
  if (labelText) {
    const byLabel = all.find((r) => labelText.test(textOf(r.labels?.[0] ?? r.closest('label'))));
    if (byLabel) { report(key, `подпись радио ${labelText}`); return byLabel; }
  }
  return null;
}
