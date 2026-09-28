// Prepare (§7.5, прогрев профиля), Clean bag, STANDBY проигравшего профиля (§7.1).
import { SEL } from '../../shared/selectors';
import type { Ctl } from '../ctl';
import type { PageInfo } from '../classify';
import { bodyText, q, waitUntil } from '../dom';
import { removeAll, readBag } from './bag';

/** Прогрев: /ae/ → страна → корзина пустая → конфигурация цели (/ae/, AED, без баннера). */
export async function prepStep(c: Ctl, page: PageInfo): Promise<void> {
  const phase = c.ts.prepPhase ?? 'home';
  if (phase === 'home') {
    if (page.kind !== 'home') { await c.navigate(`${c.base}/ae/`, 'Prepare: главная'); return; }
    c.setState('PREP', 'главная /ae/ без выбора страны ✓');
    c.ts.prepPhase = 'bag';
    await c.navigate(c.bagUrl(), 'Prepare: корзина');
    return;
  }
  if (phase === 'bag') {
    if (page.kind !== 'bag') { await c.navigate(c.bagUrl(), 'Prepare: корзина'); return; }
    c.setState('PREP', 'очистка корзины');
    const n = await removeAll(c);
    c.log(n < 0 ? 'корзина не отрисовалась' : `удалено позиций: ${n}`);
    c.ts.prepPhase = 'check';
    await c.navigate(c.targetUrl(), 'Prepare: конфигурация цели');
    return;
  }
  if (phase === 'check') {
    if (page.kind !== 'product') { await c.navigate(c.targetUrl(), 'Prepare: конфигурация цели'); return; }
    c.setState('PREP', 'проверка конфигурации');
    const loaded = await waitUntil(() => (q(SEL.addToBag) || q(SEL.continueDisabled) || q(SEL.productName) ? true : null), 8000, c.signal);
    if (!loaded) {
      const detail = 'страна ✓ · корзина ✓ · страница товара пустая/закрыта — Apple Store, похоже, закрыт перед дропом; Start можно нажимать, вкладки будут обновляться';
      c.send({ t: 'PREPARED', ok: false, detail });
      c.ts.prepPhase = 'done';
      c.setMode('idle');
      c.setState('PREP_FAILED', detail);
      c.overlay.banner('Страница товара закрыта', detail, 'warn');
      return;
    }
    const onAe = location.pathname.toLowerCase().startsWith('/ae/');
    const aed = /AED/.test(bodyText());
    const banner = !!page.country;
    const ok = onAe && !banner;
    const detail = [`/ae/ ${onAe ? '✓' : '✗'}`, `AED ${aed ? '✓' : '? (цены не видно)'}`, `баннер страны ${banner ? '✗ есть' : '✓ нет'}`,
      q(SEL.continueDisabled) ? 'до старта (Continue)' : q(SEL.addToBag) ? 'Add to Bag активна' : ''].filter(Boolean).join(' · ');
    c.send({ t: 'PREPARED', ok, detail });
    c.ts.prepPhase = 'done';
    c.setMode('idle');
    c.setState(ok ? 'PREPARED' : 'PREP_FAILED', detail);
    c.overlay.banner(ok ? 'Профиль готов ✓' : 'Профиль НЕ готов', detail, ok ? 'ok' : 'warn');
  }
}

/** Clean bag: удалить всё из корзины. */
export async function cleanStep(c: Ctl, page: PageInfo): Promise<void> {
  if (page.kind !== 'bag') { await c.navigate(c.bagUrl(), 'Clean bag'); return; }
  c.setState('CLEANUP', 'очистка корзины');
  const n = await removeAll(c);
  const bag = await readBag(c, 3000);
  const empty = !!bag?.empty || SEL.txtEmptyBag.test(bodyText());
  c.send({ t: 'CLEANED', count: Math.max(n, 0) });
  c.setMode('idle');
  c.setState(empty ? 'CLEANED' : 'CLEAN_FAILED', empty ? `корзина пуста (удалено ${Math.max(n, 0)})` : 'не удалось очистить корзину');
}

/** STANDBY: профиль проиграл, держит товар как запас holdLoserBagSec (§7.1). */
export async function standbyStep(c: Ctl, page: PageInfo): Promise<void> {
  const until = c.ts.standbyUntil ?? Date.now() + c.t.holdLoserBagSec * 1000;
  c.ts.standbyUntil = until;
  if (page.kind !== 'bag') { await c.navigate(c.bagUrl(), 'STANDBY: держим корзину'); return; }
  const left = until - Date.now();
  if (left <= 0) {
    c.log('STANDBY: время удержания вышло — чищу корзину');
    c.setMode('clean');
    c.rerun('standby-expired');
    return;
  }
  c.setState('STANDBY', `запас: держим товар ещё ~${Math.round(left / 1000)} с`);
  c.renderOverlay({ countdownTo: until });
  c.timer(left, () => c.rerun('standby-expired'));
}
