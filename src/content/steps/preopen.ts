// До старта: наблюдатель JSON (§3.0, §7.3) и рефреш вкладок по фазам.
import { SEL } from '../../shared/selectors';
import { phaseOf } from '../../shared/config';
import { normPart, partUrl } from '../../shared/parts';
import { pollFm } from '../../shared/watch';
import type { Ctl } from '../ctl';
import type { PageInfo } from '../classify';
import { Aborted, sleep, waitUntil, yieldTask } from '../dom';
import { findEl } from '../find';
import { atbFlow } from './addToBag';
import { closedStep, reportStore } from './closed';
import { hasProductBootstrap, isBlankPage } from '../classify';
import { admittedStep, holdUntil } from './bot';

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
  // гидратация: ждём, что появится раньше — активная форма Add to Bag или «Continue» до старта.
  // Разметка товара уже есть (bootstrap-скрипты) — под нагрузкой гидратация может идти долго, ждём hydrateWaitMs;
  // совсем пустая страница (магазин закрыт) — ждём недолго, чтобы не растягивать цикл рефреша.
  const wait = isBlankPage() ? 1000 : hasProductBootstrap() ? c.t.hydrateWaitMs : c.os.openedAt ? 6000 : 3000;
  const what = await waitUntil(
    () => (findEl('addToBag') ? 'atb' : findEl('continueDisabled') || page.preorder ? 'pre' : null),
    wait, c.signal,
  );
  if (what === 'atb') {
    reportStore(c, false, 'Add to Bag');
    // режим бота: пустили к покупке, но заказа ещё нет — сообщить хабу и ждать ASSIGN, в корзину не класть (§6)
    if (c.lobby || c.os.spare) { admittedStep(c, page); return; }
    return atbFlow(c);
  }
  if (what === 'pre') { reportStore(c, false, 'страница товара до старта'); scheduleByPhase(c); return; }
  // ни формы покупки, ни «Continue»: магазин закрыт / пустая страница / заглушка без текста
  closedStep(c, page, isBlankPage() ? 'пустая страница' : 'нет формы покупки');
}

/** Рефреш по фазам §7.3: ARMED → PRE_RELOAD → FAST_RELOAD. */
export function scheduleByPhase(c: Ctl): void {
  const now = Date.now();
  const openAt = Date.parse(c.cfg.openAt);
  const open = !!c.os.openedAt;
  const grace = openAt + c.t.graceSec * 1000;
  const min = c.t.minReloadMs;
  if (!open && Number.isFinite(openAt) && now < openAt - PRE_WINDOW_MS) {
    // бот: прогрев за warmupSec до старта (§20.7) — корзина и обратно: cookie, кэш скриптов и соединения уже готовы
    const warmAt = c.bot && c.b?.warmupSec ? openAt - c.b.warmupSec * 1000 : 0;
    if (warmAt && !c.ts.warmedUp && c.role !== 'watcher' && now >= warmAt) {
      c.ts.warmedUp = true;
      c.setState('WARMUP', 'прогрев: корзина → назад к товару');
      void c.navigate(c.bagUrl(), 'прогрев перед стартом');
      return;
    }
    c.setState('ARMED', `рефреш с ${new Date(openAt - PRE_WINDOW_MS).toLocaleTimeString()}`);
    c.renderOverlay({ countdownTo: openAt, timerSince: undefined });
    const next = warmAt && !c.ts.warmedUp && now < warmAt ? warmAt : openAt - PRE_WINDOW_MS;
    c.timer(Math.min(next - now, 3_600_000), () => c.rerun(next === warmAt ? 'phase:warmup' : 'phase:pre'));
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
  if (!['ARMED', 'PRE_RELOAD', 'WATCHING', 'FAST_RELOAD', 'INIT', 'CLOSED', 'BUSY', 'WARMUP'].includes(c.ts.state)) return;
  // hold (§7): перед заглушкой сигнал OPEN перезагрузку не вызывает — страница пустит сама
  if (holdUntil(c) && ['CLOSED', 'BUSY'].includes(c.ts.state)) { c.log('OPEN — hold: заглушку не трогаю'); c.rerun('open-hold'); return; }
  const want = partUrl(c.base, c.target());
  const samePage = new URL(want).pathname.toLowerCase() === location.pathname.replace(/\/$/, '').toLowerCase();
  // страница загрузилась уже после OPEN (сообщение пришло с задержкой, после реконнекта) — не тратить рефреш
  if (samePage && performance.timeOrigin >= (c.os.openedAt ?? 0) - 300 && c.ts.state !== 'CLOSED' && c.ts.state !== 'BUSY') {
    c.rerun('open-fresh-page');
    return;
  }
  // бот: задержку 0–500 мс оставляем половине флота, остальные — сразу (§20.5)
  const delay = c.bot && c.b && !c.b.openJitter ? 0 : Math.random() * 500;
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

function pollJson(c: Ctl) {
  const own = c.order?.targets ?? [];
  const targets = [...new Set([...own, ...(c.os.watchTargets ?? [])])];
  return pollFm(c.base, targets, c.order?.stores ?? []);
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
