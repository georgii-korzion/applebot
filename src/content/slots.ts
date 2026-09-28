// Упорядочивание окон самовывоза (§7.6 п. 4) — чистая функция, покрыта юнит-тестом.

export interface SlotOption { value: string; label: string }

/** value вида "28-19:15-19:30" → { day, start, end } */
export function parseSlot(value: string): { day: string; start: string; end: string } | null {
  const m = /^(\d{1,2})-(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(value.trim());
  if (!m) return null;
  const pad = (t: string) => t.padStart(5, '0');
  return { day: m[1], start: pad(m[2]), end: pad(m[3]) };
}

/** Сначала окна ≥ after и ≤ before, затем остальные; порядок сайта внутри групп сохраняется. */
export function orderWindows(opts: SlotOption[], pref: { after: string | null; before: string | null }): SlotOption[] {
  const inPref = (o: SlotOption) => {
    const s = parseSlot(o.value);
    if (!s) return false;
    if (pref.after && s.start < pref.after) return false;
    if (pref.before && s.end > pref.before) return false;
    return true;
  };
  const a = opts.filter(inPref);
  const b = opts.filter((o) => !inPref(o));
  return [...a, ...b];
}
