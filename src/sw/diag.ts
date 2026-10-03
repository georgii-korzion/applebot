// webRequest — ТОЛЬКО наблюдение (§5.2): статусы /ae/shop/* для диагностики ATB_404 (§7.4)
// и запасной сигнал «ответ updateSummary пришёл» (§8.5, вариант 2). Без блокировки и модификации.
import { maskUrl } from '../shared/log';

declare const __DEV__: boolean;

interface Rec { t: number; url: string; status: number; err?: string }
const buf = new Map<number, Rec[]>();
const KEEP_MS = 30_000;

function rec(tabId: number, url: string, status: number, err?: string): void {
  if (tabId < 0) return;
  const now = Date.now();
  const arr = (buf.get(tabId) ?? []).filter((r) => now - r.t < KEEP_MS);
  arr.push({ t: now, url, status, err });
  if (arr.length > 80) arr.splice(0, arr.length - 80);
  buf.set(tabId, arr);
}

export function initDiag(onUpdateSummary: (tabId: number, acpartNone: boolean, at: number) => void): void {
  const urls = ['https://www.apple.com/ae/shop/*', 'https://*.store.apple.com/ae/shop/*'];
  if (__DEV__) urls.push('http://127.0.0.1:4777/ae/shop/*');
  chrome.webRequest.onCompleted.addListener((d) => {
    rec(d.tabId, d.url, d.statusCode);
    if (d.tabId >= 0 && /\/shop\/updateSummary/.test(d.url)) onUpdateSummary(d.tabId, /[?&]acpart=none/.test(d.url), Math.round(d.timeStamp));
  }, { urls });
  chrome.webRequest.onErrorOccurred.addListener((d) => rec(d.tabId, d.url, 0, d.error), { urls });
  // заголовки ответа главного документа — для снимков заглушки (BOT-SPEC §7): Refresh, Retry-After, имена cookie без значений
  const docUrls = ['https://www.apple.com/*', 'https://*.store.apple.com/*'];
  if (__DEV__) docUrls.push('http://127.0.0.1:4777/*');
  try {
    chrome.webRequest.onHeadersReceived.addListener((d) => {
      if (d.tabId < 0) return;
      const h: Record<string, string> = { ':status': String(d.statusCode) };
      const cookies: string[] = [];
      for (const x of d.responseHeaders ?? []) {
        const k = x.name.toLowerCase();
        if (k === 'set-cookie') { const n = (x.value ?? '').split('=')[0].trim(); if (n) cookies.push(n); continue; }
        if (KEEP_HEADERS.has(k)) h[k] = (x.value ?? '').slice(0, 300);
      }
      if (cookies.length) h['set-cookie (names)'] = cookies.join(', ');
      docHeaders.set(d.tabId, { url: maskUrl(d.url), at: Date.now(), headers: h });
      return undefined;
    }, { urls: docUrls, types: ['main_frame'] }, ['responseHeaders', 'extraHeaders']);
  } catch (e) {
    console.warn('onHeadersReceived', e);
  }
}

const KEEP_HEADERS = new Set(['refresh', 'retry-after', 'location', 'cache-control', 'content-type', 'server', 'x-frame-options', 'akamai-grn', 'x-cache', 'via', 'age', 'expires']);
const docHeaders = new Map<number, { url: string; at: number; headers: Record<string, string> }>();

/** Заголовки последнего ответа главного документа вкладки (без значений cookie). */
export function lastDocHeaders(tabId: number): Record<string, string> | undefined {
  return docHeaders.get(tabId)?.headers;
}

export function recent(tabId: number, ms = 10_000): { url: string; status: number; ago: number }[] {
  const now = Date.now();
  return (buf.get(tabId) ?? [])
    .filter((r) => now - r.t <= ms)
    .map((r) => {
      const u = new URL(r.url);
      return { url: maskUrl(u.pathname + u.search).slice(0, 180) + (r.err ? ` (${r.err})` : ''), status: r.status, ago: now - r.t };
    });
}

export function forgetTab(tabId: number): void {
  buf.delete(tabId);
  docHeaders.delete(tabId);
}
