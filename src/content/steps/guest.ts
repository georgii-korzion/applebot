// Вход: Continue as Guest (§3.5). Apple Shield / init_data не трогаем.
import type { Ctl } from '../ctl';
import { assistClick } from '../assist';
import { clickEl, clickable, waitForUrlChange } from '../dom';
import { waitEl, waitEnabled } from '../find';

export async function guestStep(c: Ctl): Promise<void> {
  const sig = c.signal;
  c.setState('GUEST', 'Continue as Guest');
  const first = await waitEl('guest', c.t.checkoutPageWaitMs, sig);
  if (!first) {
    const n = ++c.ts.checkoutRetries;
    if (n > c.cfg.retries.checkout) {
      c.setState('STUCK', 'нет кнопки Continue as Guest');
      c.alert(`Заказ ${c.order?.id}: вход`, 'Нет кнопки Continue as Guest');
      return;
    }
    await c.navigate(c.bagUrl(), 'нет кнопки гостя → корзина');
    return;
  }
  for (let attempt = 1; ; attempt++) {
    const btn = await waitEnabled('guest', 5000, sig);
    if (!btn) break;
    const from = location.href;
    if (c.assistFor('guest')) await assistClick(c, clickable(btn), 'Guest', 'Нажми Continue as Guest');
    else clickEl(btn);
    if (await waitForUrlChange(from, 6000, sig)) return;
    const n = c.fail('guest');
    c.log(`Guest: URL не сменился за 6 с (${n})`, 'warn');
    if (n >= c.t.assistAfterFailures + c.cfg.retries.checkout) break;
  }
  const n = ++c.ts.checkoutRetries;
  if (n > c.cfg.retries.checkout) {
    c.setState('STUCK', 'Continue as Guest не срабатывает');
    c.alert(`Заказ ${c.order?.id}: вход`, 'Continue as Guest не срабатывает');
    return;
  }
  await c.navigate(c.bagUrl(), 'Guest не прошёл → корзина → Check Out');
}
