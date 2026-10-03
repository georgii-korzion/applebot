// DOM-ожидания и React-совместимые действия (§8.1, §8.2).
import { track } from './perf';

export class Aborted extends Error {
  constructor(msg = 'aborted') { super(msg); this.name = 'Aborted'; }
}

export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Aborted();
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return track('pause', () => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Aborted());
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, Math.max(0, ms));
    const onAbort = () => { clearTimeout(t); reject(new Aborted()); };
    signal?.addEventListener('abort', onAbort, { once: true });
  }));
}

/**
 * Продолжить в новой задаче через MessageChannel: у задачи из postMessage timer nesting level = 0,
 * поэтому следующий setTimeout не считается «цепочкой» и не попадает под intensive throttling скрытых вкладок.
 */
export function yieldTask(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
    ch.port2.postMessage(0);
  });
}

export const q = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
export const qa = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => Array.from(root.querySelectorAll<T>(sel));

/**
 * Ждёт, пока pred() вернёт truthy: MutationObserver + страховочная проверка раз в 250 мс
 * (атрибуты вроде `disabled` и текст меняются не всегда заметно для observer'а).
 * Возвращает значение или null по таймауту. На abort — Aborted.
 */
export function waitUntil<T>(pred: () => T | null | undefined | false, timeout: number, signal?: AbortSignal): Promise<T | null> {
  return track('wait', () => new Promise<T | null>((resolve, reject) => {
    if (signal?.aborted) return reject(new Aborted());
    let done = false;
    const check = () => {
      if (done) return;
      let v: T | null | undefined | false = null;
      try { v = pred(); } catch { v = null; }
      if (v) finish(v as T);
    };
    const finish = (v: T | null, err?: Error) => {
      if (done) return;
      done = true;
      mo.disconnect();
      clearInterval(iv);
      clearTimeout(to);
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err); else resolve(v);
    };
    const onAbort = () => finish(null, new Aborted());
    const mo = new MutationObserver(check);
    mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    const iv = setInterval(check, 250);
    const to = setTimeout(() => finish(null), timeout);
    signal?.addEventListener('abort', onAbort, { once: true });
    check();
  }));
}

export function waitFor<T extends Element = HTMLElement>(sel: string, timeout: number, signal?: AbortSignal, root: ParentNode = document): Promise<T | null> {
  return waitUntil(() => root.querySelector<T>(sel), timeout, signal);
}

export function waitForText(re: RegExp, root: HTMLElement | null, timeout: number, signal?: AbortSignal): Promise<string | null> {
  return waitUntil(() => {
    const m = re.exec((root ?? document.body)?.innerText ?? '');
    return m ? m[0] : null;
  }, timeout, signal);
}

/** Смена URL в SPA ловится опросом (pushState не даёт событий, §8.3). */
export function waitForUrl(re: RegExp, timeout: number, signal?: AbortSignal): Promise<string | null> {
  if (re.test(location.href)) return Promise.resolve(location.href);
  return track('wait', () => new Promise<string | null>((resolve, reject) => {
    const iv = setInterval(() => { if (re.test(location.href)) end(location.href); }, 50);
    const to = setTimeout(() => end(null), timeout);
    const onAbort = () => { clearInterval(iv); clearTimeout(to); reject(new Aborted()); };
    const end = (v: string | null) => { clearInterval(iv); clearTimeout(to); signal?.removeEventListener('abort', onAbort); resolve(v); };
    signal?.addEventListener('abort', onAbort, { once: true });
  }));
}

export function waitForUrlChange(from: string, timeout: number, signal?: AbortSignal): Promise<string | null> {
  return track('wait', () => new Promise<string | null>((resolve, reject) => {
    const iv = setInterval(() => { if (location.href !== from) end(location.href); }, 50);
    const to = setTimeout(() => end(null), timeout);
    const onAbort = () => { clearInterval(iv); clearTimeout(to); reject(new Aborted()); };
    const end = (v: string | null) => { clearInterval(iv); clearTimeout(to); signal?.removeEventListener('abort', onAbort); resolve(v); };
    signal?.addEventListener('abort', onAbort, { once: true });
  }));
}

/** Первое из нескольких условий: [метка, промис]. null-результаты не считаются победой. */
export async function raceFirst<K extends string>(items: [K, Promise<unknown>][], timeout: number, signal?: AbortSignal): Promise<{ key: K | 'timeout'; value: unknown }> {
  return new Promise((resolve, reject) => {
    let left = items.length;
    const to = setTimeout(() => resolve({ key: 'timeout', value: null }), timeout);
    const onAbort = () => { clearTimeout(to); reject(new Aborted()); };
    signal?.addEventListener('abort', onAbort, { once: true });
    for (const [key, p] of items) {
      p.then((v) => {
        if (v !== null && v !== undefined && v !== false) {
          clearTimeout(to); signal?.removeEventListener('abort', onAbort); resolve({ key, value: v });
        } else if (--left === 0) {
          clearTimeout(to); signal?.removeEventListener('abort', onAbort); resolve({ key: 'timeout', value: null });
        }
      }, (e) => { if (e instanceof Aborted) return; if (--left === 0) { clearTimeout(to); resolve({ key: 'timeout', value: null }); } });
    }
  });
}

// ---------- элементы ----------

/** Элемент с data-autom может быть самим input, label или обёрткой. */
export function resolveInput(el: Element | null): HTMLInputElement | null {
  if (!el) return null;
  if (el instanceof HTMLInputElement) return el;
  if (el instanceof HTMLLabelElement && el.control instanceof HTMLInputElement) return el.control;
  const inner = el.querySelector('input');
  if (inner) return inner;
  const lab = el.closest('label');
  if (lab?.control instanceof HTMLInputElement) return lab.control;
  return null;
}

/** Поле формы: `input${sel}, ${sel} input` (§8.2). */
export function findField(sel: string, root: ParentNode = document): HTMLInputElement | null {
  const bare = sel.replace(/^(input|textarea)(?=\[)/, '');
  return root.querySelector<HTMLInputElement>(`input${bare}, ${bare} input, textarea${bare}, ${bare} textarea`);
}

export function findSelect(sel: string, root: ParentNode = document): HTMLSelectElement | null {
  const bare = sel.replace(/^select(?=\[)/, '');
  return root.querySelector<HTMLSelectElement>(`select${bare}, ${bare} select`);
}

export function isChecked(el: Element | null): boolean {
  return !!resolveInput(el)?.checked;
}

/** Клик по radio через label (Apple прячет сами input). */
export function pickRadio(el: Element): void {
  if (el instanceof HTMLLabelElement) { el.click(); return; }
  const input = resolveInput(el);
  const label = input?.labels?.[0] ?? input?.closest('label') ?? (el.closest('label') as HTMLElement | null) ?? input ?? el;
  (label as HTMLElement).click();
}

/** select: нативный сеттер + события (el.value = x Apple не видит). */
export function setSelect(el: HTMLSelectElement, value: string): boolean {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return el.value === value;
}

/** Текстовое поле (React). */
export function setInput(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.focus();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
  el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
}

export function isEnabled(el: Element | null): boolean {
  if (!el) return false;
  const b = el as HTMLButtonElement;
  if (b.disabled) return false;
  if (el.getAttribute('aria-disabled') === 'true') return false;
  if (el.classList.contains('disabled')) return false;
  return true;
}

export function clickable(el: Element): HTMLElement {
  return ((el.closest('button, a, [role="button"]') as HTMLElement | null) ?? (el as HTMLElement));
}

export function clickEl(el: Element): void {
  const c = clickable(el);
  c.scrollIntoView({ block: 'center' });
  c.click();
}

export function textOf(el: Element | null | undefined): string {
  return ((el as HTMLElement | null)?.innerText ?? el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export function bodyText(): string {
  return document.body?.innerText ?? '';
}

export function isVisible(el: Element | null): boolean {
  if (!el) return false;
  const r = (el as HTMLElement).getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  const cs = getComputedStyle(el as HTMLElement);
  return cs.visibility !== 'hidden' && cs.display !== 'none';
}

/** Сколько раз regex (глобально) встречается в тексте страницы — для «нового текста ошибки». */
export function countMatches(re: RegExp, root: HTMLElement | null = document.body): number {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  return ((root?.innerText ?? '').match(g) ?? []).length;
}

/** Ждёт, пока совпадений regex станет больше, чем было (новая ошибка). Возвращает последний текст. */
export function waitForNewMatch(re: RegExp, before: number, timeout: number, signal?: AbortSignal): Promise<string | null> {
  return waitUntil(() => {
    if (countMatches(re) <= before) return null;
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    const all = (document.body?.innerText ?? '').match(g) ?? [];
    return all[all.length - 1] ?? 'error';
  }, timeout, signal);
}

/** Строка ошибки вокруг совпадения (для уведомлений) — ближайший элемент с этим текстом. */
export function errorContext(re: RegExp): string {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = n.textContent ?? '';
    if (re.test(t)) return t.replace(/\s+/g, ' ').trim().slice(0, 200);
  }
  return '';
}

/**
 * Ждёт завершения ресурса по имени (PerformanceObserver) после момента t0 (performance.now()).
 * Вариант 1 из §8.5; SW-вариант 2 — через onNet().
 */
export function waitForResource(re: RegExp, t0: number, timeout: number, signal?: AbortSignal, netFallback?: (cb: (acpartNone: boolean, at: number) => void) => () => void, needAcpart = false, t0Epoch = Date.now()): Promise<boolean> {
  return track('net', () => new Promise<boolean>((resolve, reject) => {
    if (signal?.aborted) return reject(new Aborted());
    let done = false;
    const finish = (v: boolean, err?: Error) => {
      if (done) return;
      done = true;
      try { po.disconnect(); } catch { /* */ }
      unsub?.();
      clearTimeout(to);
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err); else resolve(v);
    };
    const matches = (e: PerformanceEntry) => {
      const r = e as PerformanceResourceTiming;
      return re.test(r.name) && r.responseEnd > t0;
    };
    const existing = performance.getEntriesByType('resource').some(matches);
    const po = new PerformanceObserver((list) => { if (list.getEntries().some(matches)) finish(true); });
    try { po.observe({ type: 'resource', buffered: false }); } catch { /* */ }
    const unsub = netFallback?.((acpartNone, at) => {
      if (at >= t0Epoch - 50 && (!needAcpart || acpartNone)) finish(true);
    });
    const onAbort = () => finish(false, new Aborted());
    signal?.addEventListener('abort', onAbort, { once: true });
    const to = setTimeout(() => finish(false), timeout);
    if (existing) finish(true);
  }));
}

export function cookieNames(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of document.cookie.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
