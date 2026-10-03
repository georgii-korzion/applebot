// bot bench (BOT-SPEC §20): N прогонов до Review (stopBeforePay) на флоте 1/10/20 браузеров; таблица по шагам
// (медиана, худший) с разбивкой «сеть / ожидание элемента / пауза в коде / прочее». Сначала замер, потом оптимизация.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BotConfig, Secrets, BotOrder } from './config';
import { startOrchestrator } from './orchestrator';
import type { EventRec } from './store';

const med = (a: number[]) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const ms = (x: number) => (Number.isFinite(x) ? `${Math.round(x)}` : '—');

export interface BenchRun { size: number; run: number; toReview: number[]; steps: EventRec[]; missed: number }

/** Конфиг замера: openAt в прошлом, стоп на Review, n заказов на тестовый товар (получатели по кругу — оплаты нет). */
export function benchConfig(cfg: BotConfig, sec: Secrets, n: number, runtimeDir: string): BotConfig {
  const base = cfg.orders[0];
  const recips = Object.keys(sec.recipients);
  const orders: BotOrder[] = Array.from({ length: n }, (_, i) => ({
    ...base, id: `T${i + 1}`, priority: i + 1, targets: cfg.bench.targets, recipient: recips[i % recips.length], payment: 'card',
  }));
  return {
    ...cfg, runtimeDir, openAt: new Date(Date.now() - 5000).toISOString(), orders,
    fleet: { ...cfg.fleet, browsers: n, claimersPerOrder: 1, adaptive: false, strategyMix: { refresh: 1, hold: 0 }, warmupSec: 0 },
    payment: { ...cfg.payment, stopBeforePay: true },
    notify: { ...cfg.notify, telegram: { ...cfg.notify.telegram, enabled: false }, webhooks: { ...cfg.notify.webhooks, enabled: false } },
  };
}

export async function runBench(cfg: BotConfig, sec: Secrets, root: string, opts: { sizes: number[]; runs: number; timeoutSec?: number; log?: (s: string) => void }): Promise<string> {
  const log = opts.log ?? console.log;
  const results: BenchRun[] = [];
  for (const size of opts.sizes) {
    for (let run = 1; run <= opts.runs; run++) {
      const dir = resolve(root, cfg.runtimeDir, 'bench', `n${size}`);
      const bc = benchConfig(cfg, sec, size, dir);
      log(`▶ bench: ${size} браузер(ов), прогон ${run}/${opts.runs}`);
      const orch = await startOrchestrator(bc, sec, root, { fresh: true });
      const t0 = Date.now();
      const deadline = t0 + (opts.timeoutSec ?? 180) * 1000;
      const reviewAt = new Map<string, number>();
      const steps: EventRec[] = [];
      const off = orch.store.onEvent((e) => {
        if (e.type === 'step') steps.push(e);
        if (e.type === 'state' && e.state === 'REVIEW' && !reviewAt.has(String(e.browser))) reviewAt.set(String(e.browser), e.ts);
      });
      while (Date.now() < deadline && reviewAt.size < size) await new Promise((r) => setTimeout(r, 500));
      off();
      const opened = orch.hub.openedAt ?? t0;
      const toReview = [...reviewAt.values()].map((t) => (t - opened) / 1000);
      results.push({ size, run, toReview, steps, missed: size - reviewAt.size });
      log(`  до Review: медиана ${med(toReview).toFixed(1)} с, худший ${toReview.length ? Math.max(...toReview).toFixed(1) : '—'} с, не дошли ${size - reviewAt.size}`);
      // корзины очистить, браузеры закрыть (профили остаются прогретыми для следующего прогона)
      for (const b of orch.hub.browsers.values()) orch.hub.send(b.id, { t: 'COMMAND', cmd: 'clean' });
      await new Promise((r) => setTimeout(r, 6000));
      await orch.stop(true);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  const out: string[] = ['# bot bench', '', `Товар: ${cfg.bench.targets.join(', ')} · прогонов: ${opts.runs} · ${new Date().toLocaleString()}`, ''];
  out.push('## От OPEN до Review', '', '| браузеров | медиана, с | худший, с | не дошли |', '|---|---|---|---|');
  const base: Record<string, number> = {};
  for (const size of opts.sizes) {
    const rs = results.filter((r) => r.size === size);
    const all = rs.flatMap((r) => r.toReview);
    out.push(`| ${size} | ${med(all).toFixed(1)} | ${all.length ? Math.max(...all).toFixed(1) : '—'} | ${rs.reduce((a, r) => a + r.missed, 0)} |`);
  }
  for (const size of opts.sizes) {
    const st = results.filter((r) => r.size === size).flatMap((r) => r.steps);
    const names = [...new Set(st.map((s) => String(s.state)))];
    out.push('', `## Шаги · ${size} браузер(ов), мс`, '', '| шаг | n | медиана | худший | сеть | ожидание | пауза | прочее (код, загрузка) | vs 1 браузер |', '|---|---|---|---|---|---|---|---|---|');
    for (const name of names) {
      const xs = st.filter((s) => s.state === name);
      const m = med(xs.map((s) => Number(s.ms)));
      if (size === opts.sizes[0]) base[name] = m;
      const rel = base[name] ? `${(((m - base[name]) / base[name]) * 100).toFixed(0)} %` : '';
      const net = med(xs.map((s) => Number(s.net))), wait = med(xs.map((s) => Number(s.wait))), pause = med(xs.map((s) => Number(s.pause)));
      out.push(`| ${name} | ${xs.length} | ${ms(m)} | ${ms(Math.max(...xs.map((s) => Number(s.ms))))} | ${ms(net)} | ${ms(wait)} | ${ms(pause)} | ${ms(m - net - wait - pause)} | ${size === opts.sizes[0] ? '' : rel} |`);
    }
  }
  out.push('', 'Цель (§20): медиана OPEN → Review ≤ 15 с на одном браузере; на полном флоте время шага не хуже чем на 20 %.');
  const text = out.join('\n');
  const dir = resolve(root, cfg.runtimeDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `bench-${new Date().toISOString().replace(/[:.]/g, '-')}.md`), text);
  return text;
}
