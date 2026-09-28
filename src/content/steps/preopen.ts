// До старта: наблюдатель JSON (§3.0, §7.3) и рефреш вкладок по фазам.
import { SEL } from '../../shared/selectors';
import { normPart, partUrl } from '../../shared/parts';
import type { Ctl } from '../ctl';
import type { PageInfo } from '../classify';
import { Aborted, q, sleep, waitUntil } from '../dom';
import { atbFlow } from './addToBag';

const PRE_WINDOW_MS = 60_000;

/** Страница конфигурации в режиме гонки. */
export async function productStep(c: Ctl, page: PageInfo): Promise<void> {
  const target = c.target();
  if (!target) { c.setState('STUCK', 'в заказе нет targets'); return; }
  if (page.part && normPart(page.part) !== target) {
    await c.navigate(c.targetUrl(), `страница другого товара (${page.part}) → цель ${target}`, true);
    return;
  }
  ensureWatcher(c);
  // гидратация: ждём, что появится раньше — активная форма Add to Bag или «Continue» до старта
  const what = await waitUntil(
    () => (q(SEL.addToBag) ? 'atb' : q(SEL.continueDisabled) || page.preorder ? 'pre' : null),
    c.os.openedAt ? 6000 : 3000, c.signal,
  );
  if (what === 'atb') return atbFlow(c);
  if (!what) c.log('нет ни add-to-cart, ни continueButton — страница не догрузилась?', 'warn');
  scheduleByPhase(c);
}

/** Рефреш по фазам §7.3: ARMED → PRE_RELOAD → FAST_RELOAD. */
export function scheduleByPhase(c: Ctl): void {
  const now = Date.now();
  const openAt = Date.parse(c.cfg.openAt);
  const open = !!c.os.openedAt;
  const grace = openAt + c.t.graceSec * 1000;
  const min = c.t.minReloadMs;
  if (!open && Number.isFinite(openAt) && now < openAt - PRE_WINDOW_MS) {
    c.setState('ARMED', `рефреш с ${new Date(openAt - PRE_WINDOW_MS).toLocaleTimeString()}`);
    c.renderOverlay({ countdownTo: openAt, timerSince: undefined });
    c.timer(Math.min(openAt - PRE_WINDOW_MS - now, 3_600_000), () => c.rerun('phase:pre'));
    return;
  }
  if (!open && Number.isFinite(openAt) && now < grace) {
    c.renderOverlay({ countdownTo: openAt });
    if (c.role === 'watcher') {
      c.setState('WATCHING', 'опрос fulfillment-messages, без рефреша');
      c.timer(grace - now, () => c.rerun('phase:grace'));
      return;
    }
    c.setState('PRE_RELOAD', `рефреш ~${c.t.preOpenReloadMs} мс`);
    c.scheduleReload(Math.max(c.jit(c.t.preOpenReloadMs), min), 'pre-open');
    return;
  }
  c.renderOverlay({ countdownTo: undefined, timerSince: c.os.openedAt, timerLabel: 'OPEN' });
  c.setState('FAST_RELOAD', open ? 'продажи открыты — ждём активную Add to Bag' : 'сигнала OPEN нет после openAt+grace');
  c.scheduleReload(Math.max(c.jit(c.t.postOpenReloadMs), min), 'post-open');
}

/** Сигнал OPEN от SW: первый рефреш со случайной задержкой 0–500 мс (§7.2). */
export function onOpen(c: Ctl): void {
  if (c.ts.mode !== 'race') return;
  if (!['ARMED', 'PRE_RELOAD', 'WATCHING', 'FAST_RELOAD', 'INIT'].includes(c.ts.state)) return;
  const delay = Math.random() * 500;
  const want = partUrl(c.base, c.target());
  const samePage = new URL(want).pathname.toLowerCase() === location.pathname.replace(/\/$/, '').toLowerCase();
  c.stopAll();
  c.setState('FAST_RELOAD', 'OPEN!');
  setTimeout(() => {
    if (!samePage) void c.navigate(want, 'OPEN → активная цель', true);
    else void c.reload('OPEN');
  }, delay);
}

// ---------- наблюдатель ----------
let watching: AbortController | null = null;

export function ensureWatcher(c: Ctl): void {
  const should = c.role === 'watcher' && c.ts.mode === 'race' && !c.os.openedAt && !c.ts.paused;
  if (should && !watching) {
    watching = new AbortController();
    void watchLoop(c, watching.signal).catch((e) => { if (!(e instanceof Aborted)) c.log(`наблюдатель упал: ${e}`, 'error'); }).finally(() => { watching = null; });
  } else if (!should && watching) {
    watching.abort();
    watching = null;
  }
}

interface Buy { isBuyable: boolean; reason?: string; quote?: string }

function fmUrl(c: Ctl, parts: string[]): string {
  const store = c.order?.stores[0] ?? 'R597';
  const ps = parts.map((p, i) => `parts.${i}=${p}`).join('&');
  return `${c.base}/ae/shop/fulfillment-messages?fae=true&pl=true&mts.0=regular&mts.1=compact&${ps}&searchNearby=true&store=${store}`;
}

async function pollJson(c: Ctl): Promise<{ statuses: Record<string, Buy>; pickup: string }> {
  const own = c.order?.targets ?? [];
  const targets = [...new Set([...own, ...(c.os.watchTargets ?? [])])];
  const statuses: Record<string, Buy> = {};
  const pick: string[] = [];
  for (let i = 0; i < targets.length; i += 3) {
    const chunk = targets.slice(i, i + 3);
    const r = await fetch(fmUrl(c, chunk), { credentials: 'include', cache: 'no-store', headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const content = j?.body?.content ?? j?.content ?? {};
    for (const p of chunk) {
      const dm = content?.deliveryMessage?.[p] ?? {};
      const b = dm?.compact?.buyability ?? dm?.regular?.buyability ?? {};
      statuses[p] = {
        isBuyable: dm?.compact?.buyability?.isBuyable === true || dm?.regular?.buyability?.isBuyable === true,
        reason: b?.reason,
        quote: dm?.compact?.quote ?? dm?.regular?.quote,
      };
    }
    for (const s of content?.pickupMessage?.stores ?? []) {
      if (!c.order?.stores.includes(s.storeNumber)) continue;
      for (const p of chunk) {
        const pa = s.partsAvailability?.[p];
        if (pa) pick.push(`${s.storeNumber}:${p}=${pa.pickupDisplay}`);
      }
    }
  }
  return { statuses, pickup: pick.join(' ') };
}

/** Запасной сигнал: из HTML конфигурации пропала строка «Pre-order starting». */
async function pollHtml(c: Ctl): Promise<boolean> {
  const r = await fetch(c.targetUrl(), { credentials: 'include', cache: 'no-store' });
  if (!r.ok) return false;
  const html = await r.text();
  if (SEL.txtBusy.test(html.slice(0, 20000)) && !/data-autom=/.test(html)) return false;
  const productPage = /data-autom="(add-to-cart|continueButton|summary-productName)"|PRODUCT_SELECTION_BOOTSTRAP/.test(html);
  return productPage && !html.includes(SEL.txtPreorder);
}

async function watchLoop(c: Ctl, signal: AbortSignal): Promise<void> {
  let cycle = 0;
  let errors = 0;
  let last = '';
  c.log('наблюдатель запущен');
  while (!signal.aborted && !c.os.openedAt) {
    cycle++;
    try {
      const { statuses, pickup } = await pollJson(c);
      errors = 0;
      const sig = JSON.stringify(statuses) + pickup;
      if (sig !== last) {
        last = sig;
        c.send({ t: 'WATCH', statuses, pickup });
      }
      const buyable = Object.entries(statuses).filter(([, s]) => s.isBuyable).map(([p]) => p);
      if (buyable.length) {
        c.send({ t: 'OPEN', source: 'json', buyable });
        break;
      }
    } catch (e) {
      errors++;
      if (errors === 1 || errors % 10 === 0) c.log(`наблюдатель: ошибка опроса (${errors}): ${e}`, 'warn');
    }
    if (cycle % 3 === 0) {
      try {
        if (await pollHtml(c)) {
          c.send({ t: 'OPEN', source: 'html', buyable: [] });
          break;
        }
      } catch { /* */ }
    }
    await sleep(Math.max(1000, c.jit(c.t.pollMs)), signal);
  }
}
