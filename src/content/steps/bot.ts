// Шаги режима бота (BOT-SPEC §6–§10): пустили → ждём заказ, запас, стратегия hold, блокировка, капча,
// «Дальше я сам», снимки страниц для разбора гипотезы 1.
import { SEL } from '../../shared/selectors';
import type { Ctl } from '../ctl';
import { classify, hasCaptcha, type PageInfo } from '../classify';
import { bodyText, waitUntil } from '../dom';
import { watchForOrderNo } from './payment';

const HOLD_LEAD_MS = 120_000;

/** Окно стратегии hold: с openAt−120 с до openAt+holdMaxWaitSec (§7). */
export function holdUntil(c: Ctl, now = Date.now()): number | null {
  const b = c.b;
  if (!c.bot || b?.strategy !== 'hold') return null;
  const openAt = Date.parse(c.cfg.openAt);
  if (!Number.isFinite(openAt)) return null;
  const until = openAt + b.holdMaxWaitSec * 1000;
  return now >= openAt - HOLD_LEAD_MS && now < until ? until : null;
}

/** Классы заглушек, на которых действует hold (§7: closed, queue, busy). */
export function isStub(kind: string): boolean {
  return kind === 'closed' || kind === 'queue' || kind === 'busy';
}

/**
 * hold: заглушку не перезагружаем и не уходим с неё, пока она сама не пустит (meta refresh, редирект,
 * появление формы покупки). Терпение — до openAt+holdMaxWaitSec, потом обычный refresh.
 */
export function holdStep(c: Ctl, page: PageInfo, reason: string, until: number): void {
  const left = until - Date.now();
  const meta = page.metaRefreshSec !== undefined ? ` · сама обновится через ${page.metaRefreshSec} с` : '';
  c.setState('HOLD', `${reason} — hold: не трогаем, ждём, пока пустит сама${meta}; терпение ещё ${Math.round(left / 1000)} с`);
  c.renderOverlay({ countdownTo: undefined, timerSince: c.ts.queueSince ?? c.ts.stateSince, timerLabel: 'hold' });
  // форма покупки появилась без перезагрузки (SPA-заглушка) — диспетчер заново
  void waitUntil(() => (classify().kind !== page.kind ? true : null), left, c.signal).then((changed) => {
    if (changed) c.rerun('hold:page-changed');
  }).catch(() => {});
  c.timer(left + 50, () => c.rerun('hold:expired'));
}

/** Пустили к покупке (рабочая форма Add to Bag), заказа ещё нет — сообщить хабу и ждать ASSIGN (§6.2). */
export function admittedStep(c: Ctl, page: PageInfo): void {
  if (!c.ts.admitSent) {
    c.ts.admitSent = true;
    c.ts.admittedAt = Date.now();
    void c.save();
    c.send({ t: 'ADMITTED', part: page.part, at: c.ts.admittedAt });
    snapshot(c, page, 'admitted');
  }
  if (c.os.spare) {
    c.setState('SPARE', 'пустили, но заказов не хватило — стою на странице товара, в корзину не кладу');
  } else {
    c.setState('ADMITTED', 'пустили к покупке — жду заказ от хаба');
  }
  c.renderOverlay({ timerSince: c.ts.admittedAt, timerLabel: 'пустили' });
  // страховка: заказ мог прийти, пока вкладка перезагружалась
  c.timer(5000, () => c.rerun('admitted-wait'));
}

/** 403/429/«Access Denied» (§8): один рефреш через 5 с; не прошло — хабу BLOCKED, дальше рефреш раз в 30 с. */
export function blockedStep(c: Ctl, page: PageInfo): void {
  const n = (c.ts.blockedInRow ?? 0) + 1;
  c.ts.blockedInRow = n;
  const text = `${document.title} ${bodyText().slice(0, 200)}`.replace(/\s+/g, ' ').trim();
  if (n === 1) {
    snapshot(c, page, 'blocked');
    c.setState('BLOCKED', `доступ закрыт (${page.status || 'Access Denied'}) — один рефреш через 5 с`);
    c.scheduleReload(5000, 'blocked');
    return;
  }
  if (n === 2) {
    if (c.bot) c.send({ t: 'BLOCKED', status: page.status, text });
    else c.alert(`Заказ ${c.order?.id}: доступ закрыт`, `${page.status || ''} ${text}`.trim());
  }
  c.setState('BLOCKED', `доступ закрыт (${n}): ${text.slice(0, 80)} — рефреш раз в 30 с`);
  c.scheduleReload(30_000, 'blocked');
}

/** Капча (§8): бот её не решает — окно к человеку, после проверки продолжаем с того же шага. */
export function captchaStep(c: Ctl, page: PageInfo): void {
  c.setState('CAPTCHA', 'проверка «я не робот» — пройди её сам, бот продолжит');
  if (!c.ts.captchaSince) {
    c.ts.captchaSince = Date.now();
    void c.save();
    snapshot(c, page, 'captcha', true);
    c.needHuman('captcha', 'проверка «я не робот» — пройди её в окне');
    if (!c.bot) c.alert(`Заказ ${c.order?.id}: капча`, 'Пройди проверку «я не робот» в окне');
  }
  c.overlay.banner('👉 Пройди проверку «я не робот»', 'Бот её не решает; после проверки продолжит сам с этого шага', 'warn');
  void waitUntil(() => (!hasCaptcha() ? true : null), 600_000, c.signal).then((ok) => {
    if (!ok) return;
    c.ts.captchaSince = undefined;
    c.overlay.banner(null);
    c.log('капча пройдена — продолжаю');
    if (c.bot) c.send({ t: 'HUMAN_DONE' });
    c.rerun('captcha-passed');
  }).catch(() => {});
}

/** «Дальше я сам» (§10): бот не действует в этой вкладке, но следит за состоянием и ловит номер заказа. */
export function manualStep(c: Ctl, page: PageInfo): void {
  c.setState('MANUAL', `дальше человек (${page.kind === 'checkout' ? `checkout:${page.step ?? '?'}` : page.kind}) — бот только наблюдает`);
  c.overlay.banner(null);
  watchForOrderNo(c);
}

const SNAP_CLASSES = new Set(['queue', 'closed', 'busy', 'notfound', 'blocked', 'captcha', 'product', 'home', 'other']);

/**
 * Снимок страницы в хаб (runtime/snapshots/): HTML + заголовки ответа (добавляет SW).
 * Чекаут — только по ошибке (any=true): хаб вычищает токены перед записью.
 */
export function snapshot(c: Ctl, page: PageInfo, reason: string, any = false): void {
  if (!c.bot || !c.b?.snapshots) return;
  if (!any && !SNAP_CLASSES.has(page.kind)) return;
  const html = document.documentElement.outerHTML;
  const cut = html.length > 400_000 ? `${html.slice(0, 400_000)}\n<!-- обрезано: ${html.length} символов -->` : html;
  c.send({ t: 'SNAPSHOT', reason, cls: page.kind, title: document.title, html: cut, metaRefresh: page.metaRefreshSec, status: page.status });
}

/** Первая встреча класса страницы — снимок (§7 телеметрия). */
export function snapshotNewClass(c: Ctl, page: PageInfo): void {
  if (!c.bot || !c.b?.snapshots) return;
  const record = !!c.b.recordPages;
  if (!record && !SNAP_CLASSES.has(page.kind)) return;
  const key = page.kind === 'checkout' ? `checkout:${page.step ?? '?'}` : page.kind;
  const seen = c.ts.snapClasses ?? [];
  if (seen.includes(key)) return;
  c.ts.snapClasses = [...seen, key];
  void c.save();
  // чекаут: дать приложению дорисоваться, потом снять
  if (page.kind === 'checkout') setTimeout(() => snapshot(c, page, `page:${key}`, true), 1500);
  else snapshot(c, page, record ? `page:${key}` : `first:${page.kind}`, record);
}

/** Признак показанного QR Apple Pay (§9.2) — не снят на живом сайте (T10), набор эвристик. */
export function qrShown(hadFocus: boolean): boolean {
  if (hadFocus && !document.hasFocus()) return true; // лист — отдельное окно браузера поверх страницы
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(SEL.applePaySheet))) {
    if (el.offsetParent !== null || el.getClientRects().length) {
      const r = el.getBoundingClientRect();
      if (r.width > 40 && r.height > 40) return true;
    }
  }
  for (const d of Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], dialog[open], [aria-modal="true"]'))) {
    const r = d.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) continue;
    const t = d.innerText ?? '';
    if (/apple ?pay|\bpay\b/i.test(t) && SEL.txtApplePayQr.test(t)) return true;
  }
  return false;
}
