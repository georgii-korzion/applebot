// До старта: наблюдатель JSON (§3.0, §7.3) и ожидание открытия по стратегии профиля (FLEET-SPEC §4).
import { SEL } from '../../shared/selectors';
import { phaseOf } from '../../shared/config';
import { waitPlan } from '../../shared/strategy';
import { normPart, partUrl } from '../../shared/parts';
import { pollFm } from '../../shared/watch';
import type { Ctl } from '../ctl';
import type { PageInfo } from '../classify';
import { Aborted, sleep, waitUntil, yieldTask } from '../dom';
import { findEl } from '../find';
import { atbFlow } from './addToBag';
import { closedStep, reportStore } from './closed';
import { effectiveStrategy, holdFallback } from './common';
import { hasProductBootstrap, isBlankPage } from '../classify';

const PRE_WINDOW_MS = 60_000;
/** Состояния ожидания открытия: сюда приходит OPEN, смена роли и новый конфиг. */
export const WAITING_STATES = ['INIT', 'ARMED', 'PRE_RELOAD', 'WATCHING', 'HOLD', 'FAST_RELOAD', 'CLOSED', 'BUSY'];

/** Страница конфигурации в режиме гонки. */
export async function productStep(c: Ctl, page: PageInfo): Promise<void> {
  const target = c.target();
  if (!target) { c.setState('STUCK', 'в заказе нет targets'); return; }
  if (page.part && normPart(page.part) !== target) {
    await c.navigate(c.targetUrl(), `страница другого товара (${page.part}) → цель ${target}`, true);
    return;
  }
  ensureWatcher(c);
  // гидратация: ждём, что появится раньше — активная форма Add to Bag или «Continue» до старта.
  // Разметка товара уже есть (bootstrap-скрипты) — под нагрузкой гидратация может идти долго, ждём hydrateWaitMs;
  // совсем пустая страница (магазин закрыт) — ждём недолго, чтобы не растягивать цикл рефреша.
  const wait = isBlankPage() ? 1000 : hasProductBootstrap() ? c.t.hydrateWaitMs : c.os.openedAt ? 6000 : 3000;
  const what = await waitUntil(
    () => (findEl('addToBag') ? 'atb' : findEl('continueDisabled') || page.preorder ? 'pre' : null),
    wait, c.signal,
  );
  if (what === 'atb') { reportStore(c, false, 'Add to Bag'); return atbFlow(c); }
  if (what === 'pre') { reportStore(c, false, 'страница товара до старта'); scheduleByPhase(c); return; }
  // ни формы покупки, ни «Continue»: магазин закрыт / пустая страница / заглушка без текста
  closedStep(c, page, isBlankPage() ? 'пустая страница' : 'нет формы покупки');
}

/**
 * Наблюдатель JSON не рефрешится до своего OPEN — кроме случая, когда он единственная вкладка профиля
 * в стратегии refresh: тогда рефрешит как все, а JSON между загрузками опрашивает страховочный поллер SW.
 */
export function watcherHolds(c: Ctl): boolean {
  if (c.role !== 'watcher' || c.os.openedAt) return false;
  return !(effectiveStrategy(c) === 'refresh' && c.os.raceTabs.length <= 1);
}

/** Ожидание открытия по фазам и стратегии (§7.3, FLEET-SPEC §4.2): ARMED → PRE_RELOAD/HOLD → FAST_RELOAD. */
export function scheduleByPhase(c: Ctl): void {
  const now = Date.now();
  const openAt = Date.parse(c.cfg.openAt);
  const opened = !!c.os.openedAt;
  const phase = phaseOf(c.cfg, c.os.openedAt, now);
  const strategy = effectiveStrategy(c);
  const min = c.t.minReloadMs;
  const sinceOpenAt = Number.isFinite(openAt) ? now - openAt : 0;

  if (watcherHolds(c)) {
    // refresh: ждём до openAt+grace, потом рефрешим как все; hold: до holdFallbackSec после openAt
    const until = Number.isFinite(openAt) ? openAt + (strategy === 'hold' ? c.t.holdFallbackSec : c.t.graceSec) * 1000 : Infinity;
    if (now < until) {
      c.setState('WATCHING', `${strategy === 'hold' ? 'hold: ' : ''}опрос fulfillment-messages, без рефреша`);
      c.renderOverlay({ countdownTo: now < openAt ? openAt : undefined, timerSince: undefined });
      c.timer(Math.min(until - now, 3_600_000), () => c.rerun('phase:watch'));
      return;
    }
    if (strategy === 'hold') holdFallback(c, 'OPEN');
  }

  const plan = waitPlan(c.ts.holdFallback ? 'refresh' : strategy, phase, 'preorder', { opened, sinceOpenAt }, c.t);
  if (plan.fallback) holdFallback(c, 'OPEN');
  if (plan.reload === null) {
    // ARMED до openAt−60 с (любая стратегия) или hold до openAt+holdFallbackSec
    const next = phase === 'armed' ? openAt - PRE_WINDOW_MS : phase === 'pre' ? openAt : openAt + c.t.holdFallbackSec * 1000;
    const label = phase === 'armed'
      ? `рефреш с ${new Date(openAt - PRE_WINDOW_MS).toLocaleTimeString()}`
      : plan.reason;
    c.setState(phase === 'armed' ? 'ARMED' : 'HOLD', label);
    c.renderOverlay({ countdownTo: now < openAt ? openAt : undefined, timerSince: undefined });
    c.timer(Math.min(Math.max(next - now, 500), 3_600_000), () => c.rerun(`phase:${phase}`));
    return;
  }
  if (phase === 'post' || opened) {
    c.renderOverlay({ countdownTo: undefined, timerSince: c.os.openedAt, timerLabel: 'OPEN' });
    c.setState('FAST_RELOAD', opened ? 'продажи открыты — ждём активную Add to Bag' : 'сигнала OPEN нет после openAt — рефреш');
    c.scheduleReload(Math.max(c.jit(plan.reload), min), 'post-open');
    return;
  }
  c.renderOverlay({ countdownTo: openAt });
  c.setState('PRE_RELOAD', `рефреш ~${plan.reload} мс`);
  c.scheduleReload(Math.max(c.jit(plan.reload), min), 'pre-open');
}

/** Сигнал OPEN от SW: первый рефреш со случайной задержкой 0–500 мс (§7.2). */
export function onOpen(c: Ctl): void {
  if (c.ts.mode !== 'race') return;
  if (!WAITING_STATES.includes(c.ts.state)) return;
  const want = partUrl(c.base, c.target());
  const samePage = new URL(want).pathname.toLowerCase() === location.pathname.replace(/\/$/, '').toLowerCase();
  // страница загрузилась уже после OPEN (сообщение пришло с задержкой, после реконнекта) — не тратить рефреш
  if (samePage && performance.timeOrigin >= (c.os.openedAt ?? 0) - 300 && c.ts.state !== 'CLOSED' && c.ts.state !== 'BUSY') {
    c.rerun('open-fresh-page');
    return;
  }
  const delay = Math.random() * 500;
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

/** Опрос только своих целей: чужие профили за свои сессии отвечают сами (FLEET-SPEC §3). */
function pollJson(c: Ctl) {
  return pollFm(c.base, c.order?.targets ?? [], c.order?.stores ?? []);
}

/**
 * Запасной сигнал: в HTML конфигурации появилась кнопка add-to-cart (и пропала «Continue» до старта).
 * Только пропажи строки «Pre-order starting» недостаточно: смена текста Apple дала бы ложный OPEN
 * и часы рефреша раз в 1,5 с у всех вкладок.
 */
async function pollHtml(c: Ctl): Promise<boolean> {
  const r = await fetch(c.targetUrl(), { credentials: 'include', cache: 'no-store' });
  if (!r.ok) return false;
  const html = await r.text();
  if (!/data-autom="add-to-cart"/.test(html)) return false;
  if (/data-autom="continueButton"/.test(html)) return false;
  return !html.includes(SEL.txtPreorder);
}

const SW_TICK_FRESH_MS = 3500;

async function watchLoop(c: Ctl, signal: AbortSignal): Promise<void> {
  let cycle = 0;
  let errors = 0;
  let last = '';
  c.log('наблюдатель запущен');
  while (!signal.aborted && !c.os.openedAt) {
    cycle++;
    // страховочный поллер в SW уже опрашивает (эта вкладка, видимо, заторможена браузером) — не дублировать запросы
    const swFresh = Date.now() - c.swWatchAt < SW_TICK_FRESH_MS;
    if (!swFresh) {
      try {
        const { statuses, pickup, buyable } = await pollJson(c);
        errors = 0;
        c.send({ t: 'WATCH_TICK', ok: true });
        const sig = JSON.stringify(statuses) + pickup;
        if (sig !== last) {
          last = sig;
          c.send({ t: 'WATCH', statuses, pickup });
        }
        if (buyable.length) {
          c.send({ t: 'OPEN', source: 'json', buyable });
          break;
        }
      } catch (e) {
        errors++;
        c.send({ t: 'WATCH_TICK', ok: false });
        if (errors === 1 || errors % 10 === 0) c.log(`наблюдатель: ошибка опроса (${errors}): ${e}`, 'warn');
      }
      // HTML страницы товара тяжёлый: задолго до старта — раз в ~30 с, в последнюю минуту и после — раз в ~6 с
      if (cycle % (phaseOf(c.cfg, c.os.openedAt) === 'armed' ? 25 : 5) === 0) {
        try {
          if (await pollHtml(c)) {
            c.send({ t: 'OPEN', source: 'html', buyable: [] });
            break;
          }
        } catch { /* */ }
      }
    }
    // разорвать цепочку таймеров: у скрытой вкладки Chrome через 5 минут режет цепочки setTimeout до 1 раза в минуту
    await yieldTask();
    await sleep(Math.max(1000, c.jit(c.t.pollMs)), signal);
  }
}
