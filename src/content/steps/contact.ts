// Контакты получателя (§3.7): selfPickup + 4 поля, React-совместимый ввод.
import { SEL } from '../../shared/selectors';
import { maskEmail, maskPhone } from '../../shared/log';
import type { Ctl } from '../ctl';
import { clickEl, countMatches, errorContext, findField, isChecked, isEnabled, pickRadio, raceFirst, setInput, sleep, waitFor, waitForNewMatch, waitForUrl, waitUntil } from '../dom';

export async function contactStep(c: Ctl): Promise<void> {
  const sig = c.signal;
  const o = c.order!;
  c.setState('CONTACT', 'контакты получателя');
  const self = await waitFor(SEL.selfPickup, 10000, sig);
  if (self && !isChecked(self)) {
    pickRadio(self);
    await sleep(250, sig);
  }
  await waitUntil(() => findField(SEL.firstName), 8000, sig);
  const fields: [string, string, string][] = [
    [SEL.firstName, o.contact.firstName, 'firstName'],
    [SEL.lastName, o.contact.lastName, 'lastName'],
    [SEL.email, o.contact.email, 'email'],
    [SEL.phone, o.contact.phone, 'phone'],
  ];
  for (const [sel, val, name] of fields) {
    const f = findField(sel);
    if (!f) { c.log(`нет поля ${name}`, 'warn'); continue; }
    if (f.value !== val) setInput(f, val);
    await sleep(60, sig);
    if (f.value !== val || f.getAttribute('aria-invalid') === 'true') c.log(`поле ${name} не принято (aria-invalid/значение)`, 'warn');
  }
  c.log(`контакт: ${o.contact.firstName[0] ?? ''}. ${o.contact.lastName[0] ?? ''}. ${maskEmail(o.contact.email)} ${maskPhone(o.contact.phone)}`);
  const label = await waitFor(SEL.contactContinue, 5000, sig);
  const btn = label ? (label.closest('button') as HTMLElement | null) ?? label : null;
  if (!btn || !isEnabled(btn)) { c.setState('STUCK', 'нет активной Continue to Payment'); return; }
  const before = countMatches(SEL.txtContactError);
  c.setState('CONTACT', 'Continue to Payment');
  clickEl(btn);
  const r = await raceFirst([
    ['next', waitForUrl(/_s=Billing/i, 15000, sig)],
    ['error', waitForNewMatch(SEL.txtContactError, before, 15000, sig)],
  ], 15000, sig);
  if (r.key === 'next') return;
  const msg = r.key === 'error' ? errorContext(SEL.txtContactError) || String(r.value) : 'нет ответа за 15 с';
  c.setState('STUCK', `контакты: ${msg}`);
  c.alert(`Заказ ${o.id}: контакты`, `Apple: ${msg}`);
  // если Apple не приняла, вкладку не трогаем — человек поправит поле, дальше продолжим сами
  const fixed = await waitForUrl(/_s=Billing/i, 600_000, sig);
  if (fixed) c.log('Billing после ручного исправления контактов');
}
