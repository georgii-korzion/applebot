// Классификация страницы (§3.10).
import { SEL } from '../shared/selectors';
import { partByPath, normPart } from '../shared/parts';
import { bodyText, isVisible, qa } from './dom';

export type Kind =
  | 'queue' | 'closed' | 'busy' | 'notfound' | 'atb-pending' | 'attach' | 'product' | 'bag'
  | 'signin' | 'checkout' | 'thankyou' | 'home' | 'other';

export interface PageInfo {
  kind: Kind;
  url: URL;
  status: number;
  step?: string;          // _s без "-init": Fulfillment | PickupContact | Billing | Review | Shipping
  country: HTMLElement | null;
  metaRefreshSec?: number; // <meta http-equiv="refresh"> — страница обновит себя сама
  part?: string;          // парт страницы конфигурации / из product=
  orderNo?: string;
  preorder?: boolean;
}

export function navStatus(): number {
  const nav = performance.getEntriesByType('navigation')[0] as (PerformanceNavigationTiming & { responseStatus?: number }) | undefined;
  return nav?.responseStatus ?? 0;
}

/** Глобальный футер apple.com содержит ссылку «United Arab Emirates» / «Choose your country or region» — это не баннер. */
function inFooter(el: Element): boolean {
  return !!el.closest('footer, #ac-globalfooter, [class*="ac-gf"], [id*="globalfooter" i]');
}

/** Контейнер баннера/модалки выбора страны или null. Разметка не снята — ищем по тексту (§7.5). */
export function findCountryContainer(): HTMLElement | null {
  for (const sel of SEL.countryContainers) {
    for (const el of qa<HTMLElement>(sel)) {
      const t = el.innerText ?? '';
      if (t.length < 3000 && SEL.txtCountry.test(t) && isVisible(el) && !inFooter(el)) return el;
    }
  }
  // запасной путь: маленький видимый блок с таким текстом и select/ссылками стран (не в футере)
  for (const el of qa<HTMLElement>('aside, section, div[role], dialog')) {
    const t = el.innerText ?? '';
    if (t.length > 0 && t.length < 1500 && SEL.txtCountry.test(t) && isVisible(el) && !inFooter(el) && el.querySelector('select, a[href*="/ae/"]')) {
      return el;
    }
  }
  return null;
}

/** Модалка (перекрывает страницу) в отличие от узкого баннера сверху. */
export function isModal(el: HTMLElement): boolean {
  if (el.getAttribute('role') === 'dialog' || el.getAttribute('aria-modal') === 'true' || el.tagName === 'DIALOG') return true;
  const r = el.getBoundingClientRect();
  return r.width * r.height > 0.4 * window.innerWidth * window.innerHeight;
}

function metaRefresh(): number | undefined {
  const m = document.querySelector<HTMLMetaElement>('meta[http-equiv="refresh" i]');
  const n = Number(/^\s*(\d+)/.exec(m?.getAttribute('content') ?? '')?.[1]);
  return Number.isFinite(n) ? n : undefined;
}

/** Сколько «наших» маркеров data-autom на странице — у заглушек и 404 их нет. */
function automCount(): number {
  return document.querySelectorAll('[data-autom]').length;
}

export function classify(): PageInfo {
  const url = new URL(location.href);
  const status = navStatus();
  const path = url.pathname.toLowerCase();
  const sp = url.searchParams;
  const text = bodyText();
  const title = document.title ?? '';
  const markers = automCount();
  const country = findCountryContainer();
  const base = { url, status, country, metaRefreshSec: metaRefresh() };
  const head = title + '\n' + text.slice(0, 4000);

  // очередь Apple: страница сама пустит дальше — её не рефрешим (проверяем раньше заглушек и закрытия)
  if (markers < 3 && SEL.txtQueue.test(head)) {
    return { ...base, kind: 'queue' };
  }
  if (markers < 3 && SEL.txtClosed.test(head)) {
    return { ...base, kind: 'closed' };
  }
  if (status === 503 || status === 541 || (SEL.txtBusy.test(title + '\n' + text.slice(0, 4000)) && markers < 3)) {
    return { ...base, kind: 'busy' };
  }
  if (/Page Not Found/i.test(title) || status === 404 || (SEL.txt404.test(text.slice(0, 3000)) && markers < 3)) {
    return { ...base, kind: 'notfound' };
  }
  const productParam = sp.get('product') ? normPart(sp.get('product')) : undefined;
  if (url.search.includes('add-to-cart=')) {
    return { ...base, kind: 'atb-pending', part: productParam };
  }
  if (path.includes('/shop/buy-iphone/')) {
    if (sp.get('step') === 'attach') return { ...base, kind: 'attach', part: productParam };
    const p = partByPath(path);
    if (p || /\/shop\/buy-iphone\/[^/]+\/[^/]+/.test(path)) {
      return { ...base, kind: 'product', part: p?.part ?? productParam, preorder: text.includes(SEL.txtPreorder) };
    }
    return { ...base, kind: 'other', part: productParam };
  }
  if (/\/shop\/bag\/?$/.test(path)) return { ...base, kind: 'bag' };
  if (/\/shop\/signin/.test(path)) return { ...base, kind: 'signin' };
  if (/\/shop\/checkout/.test(path)) {
    const m = SEL.txtOrderNo.exec(text);
    if (m && (/thank|confirm/.test(path) || SEL.txtThanks.test(text))) return { ...base, kind: 'thankyou', orderNo: m[0] };
    const s = sp.get('_s') ?? '';
    return { ...base, kind: 'checkout', step: s.replace(/-init$/i, '') || undefined };
  }
  if (/^\/ae\/?$/.test(path)) return { ...base, kind: 'home' };
  return { ...base, kind: 'other' };
}

/** Есть ли на странице хоть что-то от страницы покупки (конфигурация/форма). */
export function hasProductMarkers(): boolean {
  return !!document.querySelector(`${SEL.addToBag}, ${SEL.continueDisabled}, ${SEL.productName}, ${SEL.noTradeIn}, [data-autom^="dimensionColor"], [data-autom^="dimensionCapacity"]`);
}

/** Разметка страницы товара уже пришла (bootstrap-скрипты), даже если форма ещё не гидратирована. */
export function hasProductBootstrap(): boolean {
  if (hasProductMarkers()) return true;
  for (const s of Array.from(document.scripts)) {
    if (!s.src && s.text.length < 2_000_000 && /PRODUCT_SELECTION_BOOTSTRAP|fulfillmentBootstrap/.test(s.text)) return true;
  }
  return false;
}

/** Пустая страница: ни маркеров Apple, ни осмысленного текста. */
export function isBlankPage(): boolean {
  return document.querySelectorAll('[data-autom]').length === 0 && (document.body?.innerText ?? '').trim().length < 300;
}

/** Короткая подпись страницы для лога/SW. */
export function pageLabel(p: PageInfo): string {
  return p.kind === 'checkout' ? `checkout:${p.step ?? '?'}` : p.kind;
}
