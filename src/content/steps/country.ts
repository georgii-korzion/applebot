// Выбор страны/региона (§7.5). Разметка на живом сайте не снята (T4) — ищем по тексту.
import { SEL } from '../../shared/selectors';
import type { Ctl } from '../ctl';
import { clickEl, isVisible, qa, setSelect, sleep, textOf, waitUntil } from '../dom';

/** 'handled' — баннер обработан (возможно, идёт навигация); 'stuck' — 3 раза подряд. */
export async function handleCountry(c: Ctl, box: HTMLElement): Promise<'handled' | 'stuck'> {
  c.ts.countryInRow++;
  c.log(`COUNTRY_PICKER (${c.ts.countryInRow}): ${textOf(box).slice(0, 120)}`, 'warn');
  if (c.ts.countryInRow > 3) {
    c.setState('STUCK', 'выбор страны 3 раза подряд — проверь VPN/гео профиля');
    c.alert(`Заказ ${c.order?.id}: выбор страны`, 'Баннер выбора страны не уходит (VPN? свежий профиль?)');
    await c.save();
    return 'stuck';
  }
  c.setState('COUNTRY', 'выбор страны → United Arab Emirates');
  c.ts.lastTargetNavAt = undefined; // после выбора страны главная /ae/ — не признак закрытого магазина
  await c.save();

  const sel = box.querySelector<HTMLSelectElement>('select');
  if (sel) {
    const opt = Array.from(sel.options).find((o) => SEL.txtUAE.test(o.text) || /\/ae\/?$/i.test(o.value) || o.value.toLowerCase() === 'ae');
    if (opt && sel.value !== opt.value) setSelect(sel, opt.value);
    await sleep(150, c.signal);
  }
  const links = qa<HTMLElement>('a, button', box).filter(isVisible);
  const uae = links.find((a) => {
    if (SEL.txtUAE.test(textOf(a))) return true;
    const href = (a as HTMLAnchorElement).href;
    return !!href && /\/ae\/?(\?|$)/i.test(new URL(href, location.href).pathname + new URL(href, location.href).search);
  });
  const cont = links.find((a) => SEL.txtContinue.test(textOf(a)));
  const close = box.querySelector<HTMLElement>(SEL.countryClose);
  const target = sel ? cont ?? uae : uae ?? cont;
  if (target) clickEl(target);
  else if (close) clickEl(close);
  else c.log('в баннере страны нет ни UAE, ни Continue, ни закрытия', 'warn');

  await waitUntil(() => (!box.isConnected || !isVisible(box) ? true : null), 5000, c.signal);
  await sleep(300, c.signal);
  if (!location.pathname.toLowerCase().startsWith('/ae/')) {
    await c.navigate(c.ts.mode === 'prep' ? `${c.base}/ae/` : c.targetUrl(), 'ушли с /ae/ после выбора страны');
  }
  return 'handled';
}
