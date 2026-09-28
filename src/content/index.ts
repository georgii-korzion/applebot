// Вход content script: классификация страницы → шаг машины состояний (§6).
import type { S2C } from '../shared/messages';
import { Ctl } from './ctl';
import { classify, type PageInfo } from './classify';
import { watchRoute } from './router';
import { Overlay } from './overlay';
import { becomeStopped, busyBackoff } from './steps/common';
import { handleCountry } from './steps/country';
import { ensureWatcher, onOpen, productStep } from './steps/preopen';
import { atbResult } from './steps/addToBag';
import { checkoutClick, fixBag } from './steps/bag';
import { guestStep } from './steps/guest';
import { fulfillmentStep, shippingStep } from './steps/fulfillment';
import { contactStep } from './steps/contact';
import { checkPayTimeout, onFocusForPay, ordered, paymentStep, reviewStep, showPayBanner, watchForOrderNo } from './steps/payment';
import { cleanStep, prepStep, standbyStep } from './steps/prepare';

async function dispatch(c: Ctl): Promise<void> {
  const page = classify();
  if (c.ts.paused) { c.renderOverlay(); return; }
  if (c.ts.mode === 'idle') {
    ensureWatcher(c);
    c.renderOverlay();
    return;
  }
  if (page.country) {
    const r = await handleCountry(c, page.country);
    if (r === 'handled') c.timer(1500, () => c.rerun('after-country'));
    return;
  }
  if (c.ts.countryInRow) { c.ts.countryInRow = 0; void c.save(); }
  if (page.kind === 'busy') {
    if (c.ts.mode === 'race' && c.ts.atbPendingSince) { await atbResult(c, page); return; }
    busyBackoff(c);
    return;
  }
  c.ts.busyInRow = 0;
  switch (c.ts.mode) {
    case 'race': return raceStep(c, page);
    case 'checkout': return checkoutStep(c, page);
    case 'standby': return standbyStep(c, page);
    case 'prep': return prepStep(c, page);
    case 'clean': return cleanStep(c, page);
  }
}

// ---------- гонка за Add to Bag ----------
async function raceStep(c: Ctl, page: PageInfo): Promise<void> {
  if (c.ts.state === 'STUCK') { c.renderOverlay(); return; }
  if (c.os.inBagVerified && c.os.winnerTabId !== undefined && c.os.winnerTabId !== c.tabId) {
    becomeStopped(c, `товар уже в корзине (вкладка ${c.os.winnerTabId})`);
    return;
  }
  if (c.ts.atbPendingSince && (await atbResult(c, page))) return;
  switch (page.kind) {
    case 'product':
      return productStep(c, page);
    case 'attach':
      c.send({ t: 'ATB_RESULT', ok: true, outcome: 'OK' });
      c.setState('IN_BAG', 'step=attach');
      await c.navigate(c.bagUrl(), 'step=attach → корзина');
      return;
    case 'bag':
      if (c.ts.state === 'IN_BAG' || c.os.winnerTabId === c.tabId) return bagAfterAtb(c);
      await c.navigate(c.targetUrl(), 'к странице цели', true);
      return;
    case 'notfound':
      c.setState('FAST_RELOAD', '404 — назад к цели');
      c.timer(c.jit(c.t.atb404BackoffMs), () => { void c.navigate(c.targetUrl(), '404', true); });
      return;
    case 'atb-pending':
      c.setState('ATB_PENDING', 'URL add-to-cart= — ждём переход сайта');
      c.timer(15000, () => { void c.navigate(c.targetUrl(), 'нет step=attach за 15 с', true); });
      return;
    case 'signin':
    case 'checkout':
    case 'thankyou':
      if (c.os.winnerTabId === c.tabId) { c.setMode('checkout'); return checkoutStep(c, page); }
      await c.navigate(c.targetUrl(), 'к странице цели', true);
      return;
    default:
      await c.navigate(c.targetUrl(), 'к странице цели', true);
  }
}

async function bagAfterAtb(c: Ctl): Promise<void> {
  c.setState('IN_BAG', 'проверка корзины');
  const r = await fixBag(c, c.target());
  if (!r.ok) {
    c.send({ t: 'BAG', ok: false, detail: r.detail });
    if (r.empty) {
      c.ts.lastOutcome = 'EMPTY_BAG';
      c.setState('FAST_RELOAD', 'корзина пуста после Add to Bag — повтор');
      await c.navigate(c.targetUrl(), 'повтор Add to Bag', true);
      return;
    }
    c.setState('STUCK', r.detail);
    c.alert(`Заказ ${c.order?.id}: корзина`, r.detail);
    return;
  }
  c.send({ t: 'BAG', ok: true, detail: r.detail });
  c.setState('IN_BAG', `${r.detail} — ждём решения`);
  if (!applyDecision(c)) c.timer(6000, () => c.rerun('bag-decision-timeout'));
}

function applyDecision(c: Ctl): boolean {
  if (c.os.winnerTabId !== c.tabId) return false;
  if (c.os.decision === 'go') { c.setMode('checkout'); c.rerun('go'); return true; }
  if (c.os.decision === 'standby') { c.setMode('standby', { standbyUntil: Date.now() + c.t.holdLoserBagSec * 1000 }); c.rerun('standby'); return true; }
  return false;
}

// ---------- чекаут победителя ----------
async function checkoutStep(c: Ctl, page: PageInfo): Promise<void> {
  if (c.ts.state === 'ORDERED') { showPayBanner(c); return; }
  switch (page.kind) {
    case 'bag': {
      c.setState('CHECKOUT', 'корзина');
      const r = await fixBag(c, c.target());
      if (!r.ok) {
        c.send({ t: 'BAG', ok: false, detail: r.detail });
        if (r.empty) {
          c.setMode('race');
          c.setState('FAST_RELOAD', 'корзина пуста на чекауте — заново Add to Bag');
          await c.navigate(c.targetUrl(), 'пустая корзина', true);
          return;
        }
        c.setState('STUCK', r.detail);
        return;
      }
      return checkoutClick(c);
    }
    case 'signin':
      return guestStep(c);
    case 'checkout':
      switch ((page.step ?? '').toLowerCase()) {
        case 'fulfillment': return fulfillmentStep(c);
        case 'pickupcontact': return contactStep(c);
        case 'shipping': return shippingStep(c);
        case 'billing': return paymentStep(c);
        case 'review': reviewStep(c); return;
        default:
          c.setState('CHECKOUT', `шаг «${page.step ?? '?'}» — наблюдаю`);
          watchForOrderNo(c);
          return;
      }
    case 'thankyou':
      ordered(c, page.orderNo!);
      return;
    case 'notfound': {
      const n = ++c.ts.checkoutRetries;
      if (n > c.cfg.retries.checkout) {
        c.setState('STUCK', `404 на чекауте ${n} раз (ночные работы Apple?)`);
        c.alert(`Заказ ${c.order?.id}: чекаут`, 'Page Not Found на чекауте — проверь окно');
        return;
      }
      c.setState('CHECKOUT', `404 на чекауте (${n}) → корзина → Check Out`);
      c.timer(c.jit(1500), () => { void c.navigate(c.bagUrl(), '404 на чекауте'); });
      return;
    }
    default:
      await c.navigate(c.bagUrl(), 'чекаут: в корзину');
  }
}

// ---------- сообщения SW ----------
function onSwMessage(c: Ctl, m: S2C): void {
  switch (m.t) {
    case 'WELCOME':
      c.renderOverlay();
      ensureWatcher(c);
      break;
    case 'ROLE':
      c.role = m.role;
      c.renderOverlay();
      ensureWatcher(c);
      if (c.ts.mode === 'race' && ['WATCHING', 'PRE_RELOAD', 'ARMED'].includes(c.ts.state)) c.rerun('role');
      break;
    case 'OPEN':
      c.os.openedAt ??= Date.now();
      if (m.activeTarget) {
        c.os.activeTarget = m.activeTarget;
        if (c.ts.mode === 'race' && !c.ts.atbPendingSince) c.ts.target = m.activeTarget;
      }
      ensureWatcher(c);
      onOpen(c);
      break;
    case 'OS':
      c.os = m.os;
      ensureWatcher(c);
      if (c.ts.mode === 'race' && c.os.inBagVerified && c.os.winnerTabId !== undefined && c.os.winnerTabId !== c.tabId) {
        becomeStopped(c, `товар в корзине (вкладка ${c.os.winnerTabId})`);
      }
      break;
    case 'STOP':
      if (c.ts.mode !== 'idle') becomeStopped(c, m.reason);
      break;
    case 'GO_BAG':
      if (c.ts.mode === 'race' || c.ts.mode === 'standby') {
        c.setMode('checkout', { standbyUntil: undefined });
        c.log('GO: победитель → чекаут');
        c.rerun('go');
      }
      break;
    case 'STANDBY':
      if (c.ts.mode === 'race') {
        c.setMode('standby', { standbyUntil: Date.now() + m.holdSec * 1000 });
        c.rerun('standby');
      }
      break;
    case 'CLEAN':
      if (c.ts.mode === 'standby' || c.ts.mode === 'race') {
        c.setMode('clean', { standbyUntil: undefined });
        c.rerun('clean');
      }
      break;
    case 'FOCUS_FOR_PAY':
      onFocusForPay(c);
      break;
    case 'CONFIG':
      c.cfg = m.cfg;
      c.order = m.order;
      c.renderOverlay();
      break;
    case 'MODE':
      c.stopAll();
      c.overlay.banner(null);
      c.setMode(m.mode, m.extra ?? {});
      c.setState('INIT', `режим ${m.mode}`);
      c.rerun('mode');
      break;
    default:
      break;
  }
}

// ---------- старт ----------
async function main(): Promise<void> {
  if (window.top !== window) return;
  const w = window as unknown as { __appleDropAssistant?: boolean };
  if (w.__appleDropAssistant) return;
  w.__appleDropAssistant = true;

  const c = new Ctl();
  c.dispatch = dispatch;
  c.onMessage = (m) => onSwMessage(c, m);
  await c.connect();
  c.overlay = new Overlay(c.ts.hidden ?? c.ts.mode === 'idle');
  c.overlay.onPause = (paused) => {
    c.ts.paused = paused;
    void c.save();
    if (paused) { c.stopAll(); ensureWatcher(c); c.setState(c.ts.state, 'пауза'); }
    else c.rerun('resume');
  };
  c.overlay.onHide = (hidden) => { c.ts.hidden = hidden; void c.save(); };
  watchRoute(() => c.rerun('route'));
  setInterval(() => checkPayTimeout(c), 5000);
  c.renderOverlay();
  c.rerun('load');
}

void main();
