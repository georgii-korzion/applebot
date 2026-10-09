// Контакты получателя (§3.7): selfPickup + 4 поля, React-совместимый ввод.
import { SEL } from '../../shared/selectors';
import { maskEmail, maskPhone } from '../../shared/log';
import type { Ctl } from '../ctl';
import { isChecked, isEnabled, pickRadio, setInput, sleep, waitForUrl, waitUntil } from '../dom';
import { findField, waitEl, type Key } from '../find';
import { submitAndWait } from './submit';

export async function contactStep(c: Ctl): Promise<void> {
  const sig = c.signal;
  const o = c.order!;
  c.setState('CONTACT', 'контакты получателя');
  const self = await waitEl('selfPickup', c.t.checkoutPageWaitMs, sig);
  if (self && !isChecked(self)) {
    pickRadio(self);
    await sleep(250, sig);
  }
  await waitUntil(() => findField('firstName'), c.t.checkoutPageWaitMs, sig);
  const fields: [Key, string, string][] = [
    ['firstName', o.contact.firstName, 'firstName'],
    ['lastName', o.contact.lastName, 'lastName'],
    ['email', o.contact.email, 'email'],
    ['phone', o.contact.phone, 'phone'],
  ];
  for (const [sel, val, name] of fields) {
    const f = findField(sel);
    if (!f) { c.log(`нет поля ${name}`, 'warn'); continue; }
    if (f.value !== val) setInput(f, val);
    await sleep(60, sig);
    if (f.value !== val || f.getAttribute('aria-invalid') === 'true') c.log(`поле ${name} не принято (aria-invalid/значение)`, 'warn');
  }
  c.log(`контакт: ${o.contact.firstName[0] ?? ''}. ${o.contact.lastName[0] ?? ''}. ${maskEmail(o.contact.email)} ${maskPhone(o.contact.phone)}`);
  const label = await waitEl('contactContinue', 5000, sig);
  const btn = label ? (label.closest('button') as HTMLElement | null) ?? label : null;
  if (!btn || !isEnabled(btn)) { c.setState('STUCK', 'нет активной Continue to Payment'); return; }
  const ANY = new RegExp(`${SEL.txtContactError.source}|${SEL.txtGenericError.source}`, 'i');
  let msg = '';
  for (let attempt = 0; attempt <= c.t.checkoutErrorRetries; attempt++) {
    c.setState('CONTACT', `Continue to Payment${attempt ? ` (повтор ${attempt})` : ''}`);
    const r = await submitAndWait(c, btn, /_s=Billing/i, ANY);
    if (r.result === 'next') return;
    msg = r.text;
    // ошибка валидации («Please …») — повтор не поможет, нужен человек
    if (r.result === 'error' && !r.generic) break;
    c.log(`Continue to Payment: ${msg} — повтор`, 'warn');
    await sleep(1200, sig);
  }
  // не STUCK: заказ не потерян, поле поправит человек (STUCK передал бы заказ запасному профилю через хаб)
  c.setState('NEED_HUMAN', `контакты: ${msg} — поправь поле и нажми Continue`);
  c.alert(`Заказ ${o.id}: контакты`, `Apple: ${msg} — поправь поле в окне`);
  // если Apple не приняла, вкладку не трогаем — человек поправит поле, дальше продолжим сами
  const fixed = await waitForUrl(/_s=Billing/i, 600_000, sig);
  if (fixed) c.log('Billing после ручного исправления контактов');
}
