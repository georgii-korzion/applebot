// Add to Bag без «Page Not Found» (§7.4). Результат клика ловится на следующей загрузке страницы.
import { SEL } from '../../shared/selectors';
import { normPart, partLabel } from '../../shared/parts';
import { maskUrl } from '../../shared/log';
import type { AtbDiag, AtbOutcome } from '../../shared/messages';
import type { Ctl } from '../ctl';
import { navStatus, type PageInfo } from '../classify';
import { assistClick } from '../assist';
import { cookieNames, isChecked, isEnabled, pickRadio, q, sleep, waitForResource } from '../dom';
import { findEl, waitEl, waitEnabled } from '../find';
import { scheduleByPhase } from './preopen';
import { becomeStopped, busyMs } from './common';

export async function atbFlow(c: Ctl): Promise<void> {
  const sig = c.signal;
  const target = c.target();
  c.setState('ATB_PREP', `опции ${partLabel(target)}`);
  // 1. гидратация: кнопка обязана быть (мы здесь из-за неё); trade-in появляется вместе с ней — ждём недолго
  let btn = await waitEl('addToBag', 8000, sig);
  if (!btn) { c.log('add-to-cart пропала', 'warn'); scheduleByPhase(c); return; }
  const trade = findEl('noTradeIn') ?? await waitEl('noTradeIn', 1500, sig);
  // 2. нужный ли товар в форме
  const form = btn.closest('form');
  const prod = (form?.querySelector<HTMLInputElement>(SEL.atbProductField) ?? q<HTMLInputElement>(SEL.atbProductField))?.value;
  if (prod && normPart(prod) !== target) {
    await c.navigate(c.targetUrl(), `в форме ${prod}, нужен ${target}`, true);
    return;
  }
  const net = c.onNet.bind(c);
  // 3. No trade-in → updateSummary
  if (trade && !isChecked(trade)) {
    const t0 = performance.now(), e0 = Date.now();
    pickRadio(trade);
    if (!(await waitForResource(/\/shop\/updateSummary/, t0, 5000, sig, net, false, e0))) c.log('нет ответа updateSummary после trade-in (5 с)', 'warn');
  } else if (!trade) c.log('нет choose-noTradeIn — пропускаю', 'warn');
  // 4. No AppleCare → updateSummary с acpart=none. Без него Apple отвечает на Add to Bag «Page Not Found» (§7.4).
  //    На медленной (свежий профиль, нагрузка) странице блок AppleCare появляется через секунды после trade-in —
  //    ждём до 20 с и не жмём Add to Bag, пока выбор не подтвердился (живой сайт 04.10: 5 с не хватало → 404 по кругу).
  let sawAcpart = false;
  const ac = await waitEl('noAppleCare', 20_000, sig);
  if (ac && isChecked(ac)) sawAcpart = true;
  for (let i = 0; ac && !sawAcpart && i < 3; i++) {
    const el = findEl('noAppleCare') ?? ac;
    const t1 = performance.now(), e1 = Date.now();
    pickRadio(el);
    sawAcpart = await waitForResource(/\/shop\/updateSummary\?[^#]*acpart=none/, t1, 5000, sig, net, true, e1);
    if (!sawAcpart) c.log(`нет updateSummary с acpart=none после выбора «No AppleCare+» (попытка ${i + 1}/3)`, 'warn');
  }
  // запрос не увидели, но выбор стоит (ответ мог прийти из кэша) — ещё секунда на ответ сайта и дальше
  if (ac && !sawAcpart && isChecked(findEl('noAppleCare'))) { await sleep(1000, sig); sawAcpart = true; }
  if (!sawAcpart) {
    const n = (c.ts.fails.noAppleCare = (c.ts.fails.noAppleCare ?? 0) + 1);
    // страховка от вечного цикла на странице совсем без AppleCare: после 3 перезагрузок — как раньше, без него
    if (n <= 3) {
      c.log(ac ? '«No AppleCare+» не подтвердился — перезагрузка вместо гарантированной 404' : 'блок AppleCare не появился за 20 с — перезагрузка вместо гарантированной 404', 'warn');
      c.setState('FAST_RELOAD', `«No AppleCare+» не выбран (${n}/3) — перезагрузка, Add to Bag без него Apple отклонит`);
      c.scheduleReload(c.jit(c.t.postOpenReloadMs), 'no-acpart');
      return;
    }
    c.log('блока AppleCare нет 3 раза подряд — жму Add to Bag без него', 'warn');
  }
  c.ts.fails.noAppleCare = 0;
  // 5. кнопка активируется сама (disabled руками не снимаем)
  btn = await waitEnabled('addToBag', 12000, sig);
  if (!btn) {
    c.setState('FAST_RELOAD', 'Add to Bag не активировалась за 12 с');
    c.scheduleReload(c.jit(c.t.postOpenReloadMs), 'atb-disabled');
    return;
  }
  // 6. лок SW
  const assist = c.assistFor('atb');
  c.setState('ATB_WAIT_LOCK', 'запрос лока');
  const got = await c.acquireLock(assist ? 120_000 : c.t.atbTimeoutMs);
  if (!got) { becomeStopped(c, 'товар уже в корзине другой вкладки'); return; }
  btn = findEl('addToBag');
  if (!btn || !isEnabled(btn)) { c.send({ t: 'ATB_RESULT', ok: false, outcome: 'ATB_RELOAD' }); c.rerun('atb-button-gone'); return; }
  // 7. записать pending ДО клика — результат увидит следующая загрузка страницы
  Object.assign(c.ts, { atbPendingSince: Date.now(), atbPart: target, sawAcpartNone: sawAcpart, atbAssist: assist });
  await c.save();
  const direct = c.bot && c.b?.directAtb && !assist ? directAtbUrl(btn) : null;
  if (assist) {
    await assistClick(c, btn, 'Add to Bag', 'Нажми Add to Bag');
    c.ts.atbPendingSince = Date.now();
    void c.save();
  } else if (direct) {
    // BOT-SPEC §2, §20.6: тот же запрос, что строит JS сайта, — с токеном, который сервер выдал этой сессии (cookie as_atb)
    c.setState('ATB_PENDING', 'Add to Bag прямым запросом');
    c.log('Add to Bag прямым запросом (directAtb)');
    location.assign(direct);
  } else {
    c.setState('ATB_PENDING', 'клик Add to Bag');
    btn.scrollIntoView({ block: 'center' });
    btn.click();
  }
  c.setState('ATB_PENDING', 'ждём ответ сайта');
  // страница не сменилась → ATB_TIMEOUT
  c.timer(c.t.atbTimeoutMs, () => { void atbFail(c, 'ATB_TIMEOUT'); });
}

/** Загрузка после клика: разобрать исход (§7.4 п. 8–9). true — обработано. */
export async function atbResult(c: Ctl, page: PageInfo): Promise<boolean> {
  const elapsed = Date.now() - (c.ts.atbPendingSince ?? Date.now());
  switch (page.kind) {
    case 'attach':
    case 'bag':
      await atbOk(c, page);
      return true;
    case 'notfound':
      await atbFail(c, 'ATB_404', await collectDiag(c));
      return true;
    case 'busy':
    case 'closed':
      await atbFail(c, 'BUSY');
      return true;
    case 'queue': {
      // очередь после клика: страница сама вернёт на add-to-cart — не уходим и не рефрешим
      c.ts.queueSince ??= Date.now();
      const left = c.t.queueMaxWaitSec * 1000 - (Date.now() - c.ts.queueSince);
      c.setState('ATB_PENDING', `очередь Apple после Add to Bag — ждём, лимит ещё ${Math.max(0, Math.round(left / 1000))} с`);
      c.timer(Math.max(left, 1000), () => { c.ts.queueSince = undefined; void atbFail(c, 'ATB_TIMEOUT'); });
      return true;
    }
    case 'atb-pending': {
      // 200 на URL с add-to-cart= — ничего не делать и не уходить, сайт сам перейдёт на step=attach
      c.setState('ATB_PENDING', 'запрос принят, ждём step=attach — не уходим');
      c.timer(Math.max(15000 - elapsed, 3000), () => { void atbFail(c, 'ATB_TIMEOUT'); });
      return true;
    }
    case 'product':
      // вернулись на конфигурацию без перехода: клик не дал результата
      await atbFail(c, elapsed > c.t.atbTimeoutMs ? 'ATB_TIMEOUT' : 'ATB_RELOAD', undefined, true);
      return false;
    default:
      await atbFail(c, 'ATB_TIMEOUT');
      return true;
  }
}

async function atbOk(c: Ctl, page: PageInfo): Promise<void> {
  Object.assign(c.ts, { atbPendingSince: undefined, atb404InRow: 0, lastOutcome: 'OK' });
  c.ts.fails.atb = 0;
  c.send({ t: 'ATB_RESULT', ok: true, outcome: 'OK' });
  c.setState('IN_BAG', page.kind === 'attach' ? 'Add to Bag прошёл → корзина' : 'Add to Bag прошёл');
  await c.save();
  if (page.kind === 'attach') await c.navigate(c.bagUrl(), 'step=attach → /ae/shop/bag');
  else c.rerun('atb-ok-bag');
}

/**
 * URL Add to Bag из полей формы + acpart=none + atbtoken из cookie as_atb (токен сессии, выданный сервером).
 * Нет формы или cookie — null (тогда обычный клик).
 */
export function directAtbUrl(btn: HTMLElement): string | null {
  const form = btn.closest('form') ?? document.querySelector<HTMLFormElement>(`form:has(${SEL.atbProductField})`);
  const token = cookieNames().as_atb;
  if (!form || !token) return null;
  const fields = new FormData(form);
  const product = String(fields.get('product') ?? '');
  if (!product) return null;
  const p = new URLSearchParams();
  p.set('product', product);
  for (const k of ['purchaseOption', 'step']) { const v = fields.get(k); if (v) p.set(k, String(v)); }
  p.set('acpart', 'none');
  p.set('atbtoken', token);
  p.set('igt', 'true');
  p.set('add-to-cart', 'add-to-cart');
  return `${location.pathname}?${p.toString()}`;
}

/** Неудача Add to Bag: лок освободить, бэкофф, повтор с URL цели. */
export async function atbFail(c: Ctl, outcome: AtbOutcome, diag?: AtbDiag, stay = false): Promise<void> {
  c.ts.atbPendingSince = undefined;
  c.ts.lastOutcome = outcome;
  if (outcome === 'ATB_404') {
    c.ts.atb404InRow++;
    c.fail('atb');
  }
  c.send({ t: 'ATB_RESULT', ok: false, outcome, diag });
  if (c.ts.atb404InRow >= c.t.atb404MaxInRow) {
    c.setState('STUCK', `${c.ts.atb404InRow} раз подряд 404 на Add to Bag — см. диагностику в логе`);
    c.alert(`Заказ ${c.order?.id}: вкладка STUCK`, `Add to Bag: ${c.ts.atb404InRow}× Page Not Found подряд`);
    await c.save();
    return;
  }
  if (stay) { await c.save(); return; }
  const backoff = outcome === 'BUSY' ? busyMs(c) : c.jit(c.t.atb404BackoffMs);
  const assistNote = c.assistFor('atb') ? ' · дальше режим ассистента' : '';
  c.setState('FAST_RELOAD', `${outcome}, повтор через ${backoff} мс${assistNote}`);
  await c.save();
  c.timer(backoff, () => { void c.navigate(c.targetUrl(), `повтор после ${outcome}`, true); });
}

/** Диагностика ATB_404 (§7.4): без значений токенов и cookie (кроме geo). */
async function collectDiag(c: Ctl): Promise<AtbDiag> {
  const u = new URL(location.href);
  const sp = u.searchParams;
  const ck = cookieNames();
  const net = (await c.request({ t: 'DIAG_REQ' }, 'DIAG', 1500))?.net ?? [];
  return {
    url: maskUrl(u.pathname + u.search),
    hasAcpartNone: sp.get('acpart') === 'none',
    hasAtbtoken: !!sp.get('atbtoken'),
    hasIgt: sp.get('igt') === 'true',
    hasProduct: !!sp.get('product'),
    sawAcpartNone: c.ts.sawAcpartNone,
    navStatus: navStatus(),
    net,
    cookies: { as_atb: 'as_atb' in ck, geo: ck.geo ?? null },
    lang: navigator.language,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    countryInUrl: u.pathname.startsWith('/ae/'),
  };
}
