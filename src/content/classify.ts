// Классификация страницы (§3.10).
import { SEL } from '../shared/selectors';
import { partByPath, normPart } from '../shared/parts';
import { bodyText, isVisible, qa } from './dom';

export type Kind =
  | 'busy' | 'notfound' | 'atb-pending' | 'attach' | 'product' | 'bag'
  | 'signin' | 'checkout' | 'thankyou' | 'home' | 'other';

export interface PageInfo {
  kind: Kind;
  url: URL;
  status: number;
  step?: string;          // _s без "-init": Fulfillment | PickupContact | Billing | Review | Shipping
  country: HTMLElement | null;
  part?: string;          // парт страницы конфигурации / из product=
  orderNo?: string;
  preorder?: boolean;
}

export function navStatus(): number {
  const nav = performance.getEntriesByType('navigation')[0] as (PerformanceNavigationTiming & { responseStatus?: number }) | undefined;
  return nav?.responseStatus ?? 0;
}

/** Контейнер баннера/модалки выбора страны или null. Разметка не снята — ищем по тексту (§7.5). */
export function findCountryContainer(): HTMLElement | null {
  for (const sel of SEL.countryContainers) {
    for (const el of qa<HTMLElement>(sel)) {
      const t = el.innerText ?? '';
      if (t.length < 3000 && SEL.txtCountry.test(t) && isVisible(el)) return el;
    }
  }
  // запасной путь: маленький видимый блок с таким текстом и select/ссылками стран
  for (const el of qa<HTMLElement>('aside, section, div[role], dialog')) {
    const t = el.innerText ?? '';
    if (t.length > 0 && t.length < 1500 && SEL.txtCountry.test(t) && isVisible(el) && el.querySelector('select, a[href*="/ae/"], a[href$="/"]')) {
      return el;
    }
  }
  return null;
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
  const base = { url, status, country };

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

/** Короткая подпись страницы для лога/SW. */
export function pageLabel(p: PageInfo): string {
  return p.kind === 'checkout' ? `checkout:${p.step ?? '?'}` : p.kind;
}
