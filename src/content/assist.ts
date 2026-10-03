// Режим ассистента (§7.8): расширение готовит всё до кнопки, человек нажимает её сам.
import type { Ctl } from './ctl';
import { Aborted } from './dom';

const OUTLINE = '4px solid #30d158';

function highlight(el: HTMLElement): () => void {
  const prev = { outline: el.style.outline, offset: el.style.outlineOffset, shadow: el.style.boxShadow };
  el.style.outline = OUTLINE;
  el.style.outlineOffset = '3px';
  el.style.boxShadow = '0 0 0 8px rgba(48,209,88,.35)';
  el.scrollIntoView({ block: 'center' });
  return () => {
    el.style.outline = prev.outline;
    el.style.outlineOffset = prev.offset;
    el.style.boxShadow = prev.shadow;
  };
}

/**
 * Подсветить кнопку, вывести окно вперёд со звуком и дождаться НАСТОЯЩЕГО клика человека
 * (event.isTrusted). Расширение само ничего не нажимает.
 */
export function assistClick(c: Ctl, el: HTMLElement, step: string, msg: string): Promise<void> {
  const signal = c.signal;
  const unhl = highlight(el);
  c.setState('ASSIST', `${step}: ${msg}`);
  c.overlay.banner(`👉 ${msg}`, 'Режим ассистента: кнопку жмёшь ты, дальше расширение продолжит само', 'warn');
  c.send({ t: 'ASSIST', step, msg });
  return new Promise((resolve, reject) => {
    const onClick = (e: Event) => {
      if (!e.isTrusted) return;
      const t = e.target as Node | null;
      if (t && (el.contains(t) || t === el)) done();
    };
    const onAbort = () => { cleanup(); reject(new Aborted()); };
    const done = () => { cleanup(); c.log(`${step}: человек нажал кнопку`); if (c.bot) c.send({ t: 'HUMAN_DONE' }); resolve(); };
    const cleanup = () => {
      document.removeEventListener('click', onClick, true);
      signal.removeEventListener('abort', onAbort);
      unhl();
      c.overlay.banner(null);
    };
    document.addEventListener('click', onClick, true);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Подсветить select и дождаться, пока человек выберет значение сам (setSelect не принят, §8.2). */
export function assistSelect(c: Ctl, el: HTMLSelectElement, step: string, msg: string, accept: () => boolean): Promise<void> {
  const signal = c.signal;
  const unhl = highlight(el);
  c.setState('ASSIST', `${step}: ${msg}`);
  c.overlay.banner(`👉 ${msg}`, 'Выбери значение вручную — дальше расширение продолжит само', 'warn');
  c.send({ t: 'ASSIST', step, msg });
  return new Promise((resolve, reject) => {
    const onChange = (e: Event) => {
      if (!e.isTrusted) return;
      setTimeout(() => { if (accept()) done(); }, 150);
    };
    const onAbort = () => { cleanup(); reject(new Aborted()); };
    const done = () => { cleanup(); if (c.bot) c.send({ t: 'HUMAN_DONE' }); resolve(); };
    const cleanup = () => {
      el.removeEventListener('change', onChange, true);
      signal.removeEventListener('abort', onAbort);
      unhl();
      c.overlay.banner(null);
    };
    el.addEventListener('change', onChange, true);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
