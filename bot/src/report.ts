// bot report (BOT-SPEC §7): «стратегия × прокси → пустили через N с», что было на заглушке (тексты, механизм
// обновления: meta refresh, Refresh/Retry-After), блокировки по IP, заказы. Источник — runtime/events.ndjson и снимки.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readEvents, type EventRec } from './store';

const med = (a: number[]) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '—');

export function buildReport(runtimeDir: string): string {
  const ev = readEvents(join(runtimeDir, 'events.ndjson'));
  if (!ev.length) return 'В runtime/events.ndjson пусто — отчёт строится после запуска бота.';
  const of = (t: string) => ev.filter((e) => e.type === t);
  const launches = new Map<string, EventRec>();
  for (const e of of('launch')) launches.set(String(e.browser), e);
  const ips = new Map<string, string>();
  for (const e of of('proxy.ip')) ips.set(String(e.proxy), String(e.ip));
  const opened = ev.find((e) => e.type === 'store.opened')?.ts;
  const admitted = new Map<string, EventRec>();
  for (const e of of('browser.admitted')) if (!admitted.has(String(e.browser))) admitted.set(String(e.browser), e);
  const switches = of('strategy.switched');
  const pages = of('page');
  const out: string[] = [];
  out.push(`# Отчёт о запуске`, '', `Событий: ${ev.length} · OPEN: ${opened ? new Date(opened).toLocaleString() : 'не было'} · браузеров: ${launches.size}`, '');

  // стратегия × прокси
  type Row = { strategy: string; proxy: string; n: number; adm: number[] };
  const rows = new Map<string, Row>();
  for (const [id, l] of launches) {
    const strategy = String(l.strategy);
    const proxy = l.proxy ? `${l.proxyLabel ?? l.proxy}${ips.get(String(l.proxy)) ? ` (${ips.get(String(l.proxy))})` : ''}` : 'прямой';
    const k = `${strategy}|${proxy}`;
    const r = rows.get(k) ?? { strategy, proxy, n: 0, adm: [] };
    r.n++;
    const a = admitted.get(id);
    if (a && typeof a.sinceOpenSec === 'number') r.adm.push(a.sinceOpenSec);
    else if (a) r.adm.push(NaN);
    rows.set(k, r);
  }
  out.push('## Стратегия × прокси → пустили', '', '| стратегия | прокси | браузеров | пущено | медиана, с от OPEN | лучший, с |', '|---|---|---|---|---|---|');
  for (const r of [...rows.values()].sort((a, b) => a.strategy.localeCompare(b.strategy) || a.proxy.localeCompare(b.proxy))) {
    const t = r.adm.filter(Number.isFinite);
    out.push(`| ${r.strategy} | ${r.proxy} | ${r.n} | ${r.adm.length} | ${f1(med(t))} | ${t.length ? f1(Math.min(...t)) : '—'} |`);
  }
  // по стратегиям (с учётом стратегии в момент пропуска)
  const byS = (s: string) => [...admitted.values()].filter((a) => a.strategy === s);
  const total = (s: string) => [...launches.values()].filter((l) => l.strategy === s).length;
  const rS = byS('refresh'), hS = byS('hold');
  out.push('', '## Стратегии (в момент пропуска)', '', '| стратегия | стартовало | пущено | медиана, с |', '|---|---|---|---|');
  out.push(`| refresh | ${total('refresh')} | ${rS.length} | ${f1(med(rS.map((a) => Number(a.sinceOpenSec)).filter(Number.isFinite)))} |`);
  out.push(`| hold | ${total('hold')} | ${hS.length} | ${f1(med(hS.map((a) => Number(a.sinceOpenSec)).filter(Number.isFinite)))} |`);
  const rate = (a: number, n: number) => (n ? a / n : 0);
  const verdict = rS.length + hS.length === 0 ? 'никого не пустило — гипотезу закрыть нельзя'
    : rate(hS.length, total('hold')) > rate(rS.length, total('refresh')) + 0.2 ? '**сработала стратегия hold** (ждать на заглушке)'
      : rate(rS.length, total('refresh')) > rate(hS.length, total('hold')) + 0.2 ? '**сработала стратегия refresh** (перезагружать)'
        : 'явного победителя нет — обе стратегии пускали сопоставимо';
  out.push('', `Вывод: ${verdict}.`);
  if (switches.length) {
    out.push('', '### Переключения стратегии', '');
    for (const s of switches) out.push(`- ${new Date(s.ts).toLocaleTimeString()}: ${(s.browsers as string[]).join(', ')} → ${s.to} (${s.reason})`);
  }
  // классы страниц и рефреши
  out.push('', '## Что видели браузеры', '');
  const cls = new Map<string, Set<string>>();
  for (const p of pages) { const s = cls.get(String(p.cls)) ?? new Set(); s.add(String(p.browser)); cls.set(String(p.cls), s); }
  out.push('| класс страницы | браузеров |', '|---|---|');
  for (const [c, s] of cls) out.push(`| ${c} | ${s.size} |`);
  // заглушки: тексты и механизм обновления
  const snapDir = join(runtimeDir, 'snapshots');
  const metas: any[] = existsSync(snapDir) ? readdirSync(snapDir).filter((f) => f.endsWith('.json')).map((f) => { try { return JSON.parse(readFileSync(join(snapDir, f), 'utf8')); } catch { return null; } }).filter(Boolean) : [];
  const stubs = metas.filter((m) => ['closed', 'queue', 'busy', 'blocked', 'captcha', 'notfound'].includes(m.cls));
  if (stubs.length) {
    out.push('', '## Заглушки', '');
    const seen = new Set<string>();
    for (const m of stubs) {
      const key = `${m.cls}|${m.title}|${String(m.text).slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const h = m.headers ?? {};
      const mech = [m.metaRefresh !== undefined ? `meta refresh ${m.metaRefresh} с` : '', h.refresh ? `Refresh: ${h.refresh}` : '', h['retry-after'] ? `Retry-After: ${h['retry-after']}` : '', h[':status'] ? `HTTP ${h[':status']}` : ''].filter(Boolean).join(', ') || 'само не обновляется (нет meta refresh / Refresh)';
      out.push(`- **${m.cls}** «${m.title || '—'}» — ${String(m.text).slice(0, 200)}`, `  - обновление: ${mech}; cookie: ${h['set-cookie (names)'] ?? '—'}; снимок: ${m.reason} (${m.browser}, ${m.strategy})`);
    }
  }
  // блокировки по IP
  const blocks = of('browser.blocked');
  out.push('', '## Блокировки по IP (гипотеза 2)', '');
  if (!blocks.length) out.push('Блокировок не было.');
  else {
    const byPx = new Map<string, number>();
    for (const b of blocks) byPx.set(String(b.proxy), (byPx.get(String(b.proxy)) ?? 0) + 1);
    out.push('| прокси | блокировок |', '|---|---|');
    for (const [p, n] of byPx) out.push(`| ${p} | ${n} |`);
  }
  // заказы
  const placed = of('order.placed');
  out.push('', '## Заказы', '');
  if (!placed.length) out.push('Оформленных заказов нет.');
  else {
    out.push('| заказ | номер | браузер | стратегия | прокси | пустили, с | корзина, с | заказ, с |', '|---|---|---|---|---|---|---|---|');
    for (const p of placed) {
      const o = p.order as any; const t = (p.timings ?? {}) as any;
      out.push(`| ${o?.id} | ${o?.number} | ${p.browser} | ${p.strategy} | ${p.proxy} | ${f1(t.openToAdmittedSec)} | ${f1(t.openToBagSec)} | ${f1(t.openToOrderSec)} |`);
    }
  }
  const declines = of('card.declined');
  if (declines.length) out.push('', `Отказы карт: ${declines.map((d) => `****${d.cardLast4} (${d.orderId})`).join(', ')}`);
  const humans = of('human.needed');
  if (humans.length) out.push('', `Нужен был человек: ${humans.length} раз (${[...new Set(humans.map((h) => h.reason))].join(', ')})`);
  const text = out.join('\n');
  writeFileSync(join(runtimeDir, 'report.md'), text);
  return text;
}
