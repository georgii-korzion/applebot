// Корзина (§3.4, §7.4 п. 10): проверка/очистка, Check Out.
import { SEL } from '../../shared/selectors';
import { matchBagName, partLabel } from '../../shared/parts';
import type { Ctl } from '../ctl';
import { assistClick } from '../assist';
import { bodyText, clickEl, clickable, findSelect, isEnabled, q, qa, setSelect, sleep, textOf, waitForUrlChange, waitUntil } from '../dom';

interface BagItem { nameEl: HTMLElement; name: string; root: HTMLElement }

/** Корень позиции: наибольший предок, в котором ровно одно название. */
function itemRoot(nameEl: HTMLElement): HTMLElement {
  let el = nameEl;
  for (let i = 0; i < 12 && el.parentElement && el.parentElement !== document.body; i++) {
    if (el.parentElement.querySelectorAll(SEL.bagItemName).length > 1) break;
    el = el.parentElement;
  }
  return el;
}

function items(): BagItem[] {
  return qa<HTMLElement>(SEL.bagItemName).map((nameEl) => ({ nameEl, name: textOf(nameEl), root: itemRoot(nameEl) }));
}

/** Ждём отрисовку корзины: позиции или «Your bag is empty». */
export async function readBag(c: Ctl, timeout = 10000): Promise<{ list: BagItem[]; empty: boolean } | null> {
  const ok = await waitUntil(() => (qa(SEL.bagItemName).length || SEL.txtEmptyBag.test(bodyText()) ? true : null), timeout, c.signal);
  if (!ok) return null;
  const list = items();
  return { list, empty: list.length === 0 };
}

async function removeItem(c: Ctl, it: BagItem): Promise<boolean> {
  const before = qa(SEL.bagItemName).length;
  const rm = it.root.querySelector<HTMLElement>(SEL.bagItemRemove);
  if (!rm) { c.log(`нет кнопки удаления у «${it.name}»`, 'warn'); return false; }
  clickEl(rm);
  const done = await waitUntil(() => (qa(SEL.bagItemName).length < before ? true : null), 8000, c.signal);
  return !!done;
}

/**
 * В корзине должна остаться одна позиция нужной модели, количество 1.
 * ok=false + empty — корзина пуста; ok=false без empty — нужной модели нет.
 */
export async function fixBag(c: Ctl, target: string): Promise<{ ok: boolean; empty?: boolean; detail: string }> {
  const bag = await readBag(c);
  if (!bag) return { ok: false, detail: 'корзина не отрисовалась за 10 с' };
  if (bag.empty) return { ok: false, empty: true, detail: 'Your bag is empty' };
  const strict = bag.list.find((i) => matchBagName(i.name, target) === 'strict');
  const keep = strict ?? bag.list.find((i) => matchBagName(i.name, target) === 'loose');
  if (!keep) return { ok: false, detail: `нет ${partLabel(target)}: ${bag.list.map((i) => i.name).join('; ')}` };
  if (!strict) c.log(`название «${keep.name}» совпало без цвета — оставляю`, 'warn');
  for (const it of bag.list) {
    if (it.nameEl === keep.nameEl) continue;
    c.log(`удаляю лишнее: ${it.name}`);
    await removeItem(c, it);
  }
  // количество 1
  const cur = items().find((i) => i.name === keep.name);
  const qty = cur ? findSelect(SEL.bagItemQty, cur.root) : null;
  if (qty && qty.value !== '1') {
    c.log(`количество ${qty.value} → 1`);
    setSelect(qty, '1');
    await waitUntil(() => { const s = findSelect(SEL.bagItemQty); return s && s.value === '1' ? true : null; }, 5000, c.signal);
    await sleep(500, c.signal);
  }
  if (SEL.txtMaxQty.test(bodyText())) c.log(`Apple: ${SEL.txtMaxQty.exec(bodyText())?.[0]}`, 'warn');
  const total = textOf(q(SEL.bagTotal));
  return { ok: true, detail: `${keep.name}${total ? ` · ${total}` : ''}` };
}

/** Очистка корзины (Clean bag, проигравшие профили, Prepare). */
export async function removeAll(c: Ctl): Promise<number> {
  const bag = await readBag(c);
  if (!bag) return -1;
  let n = 0;
  for (let i = 0; i < 12; i++) {
    const list = items();
    if (!list.length) break;
    if (await removeItem(c, list[0])) n++;
    else break;
  }
  return n;
}

/** Check Out (§7.6): клик, через 5 с без смены URL — повтор; после N неудач — ассистент. */
export async function checkoutClick(c: Ctl): Promise<void> {
  const sig = c.signal;
  for (let attempt = 1; ; attempt++) {
    const btn = await waitUntil(() => { const b = q(SEL.bagCheckout); return b && isEnabled(b) ? b : null; }, 8000, sig);
    if (!btn) {
      c.setState('CHECKOUT', 'кнопка Check Out не активна — обновляю корзину');
      c.scheduleReload(2000, 'no-checkout-btn');
      return;
    }
    const from = location.href;
    if (c.assistFor('checkout')) {
      await assistClick(c, clickable(btn), 'Check Out', 'Нажми Check Out');
    } else {
      c.setState('CHECKOUT', attempt > 1 ? `Check Out, попытка ${attempt}` : 'Check Out');
      clickEl(btn);
    }
    if (await waitForUrlChange(from, 5000, sig)) return;
    const n = c.fail('checkout');
    c.log(`Check Out: URL не сменился за 5 с (${n})`, 'warn');
    if (n >= c.t.assistAfterFailures + c.cfg.retries.checkout) {
      c.setState('STUCK', 'Check Out не срабатывает');
      c.alert(`Заказ ${c.order?.id}: Check Out`, 'Кнопка Check Out не срабатывает — проверь окно');
      return;
    }
  }
}
