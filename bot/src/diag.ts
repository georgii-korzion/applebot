// bot diag: логи и снимки страниц одним zip-архивом — прислать разработчику, когда бот повёл себя странно на живом сайте.
// В архиве нет secrets.local.json и orders.txt; номера карт, контакты получателей, пароли прокси и токены замаскированы.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, arch, platform, release } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { BotConfig, Secrets } from './config';
import { chromeVersion, findChrome } from './chrome';
import { BOT_VERSION } from './version';
import { luhn } from '../../src/shared/config';

type Rule = [RegExp, string | ((m: string) => string)];

const TEXT_MAX = 4 * 1024 * 1024;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Чем заменить в текстах архива: карты, контакты, пароли прокси, токены. */
export function secretsToMask(sec: Secrets | null, extraTokens: string[] = []): Rule[] {
  const out: Rule[] = [];
  const lit = (v: string | undefined, to: string, minLen = 4) => { if (v && v.length >= minLen) out.push([new RegExp(esc(v), 'gi'), to]); };
  for (const c of sec?.cards ?? []) {
    const d = c.number.replace(/\D/g, '');
    if (d.length >= 12) {
      out.push([new RegExp(d.split('').join('[\\s-]?'), 'g'), `****${d.slice(-4)}`]);
    }
  }
  for (const [id, r] of Object.entries(sec?.recipients ?? {})) {
    lit(r.email, `<email ${id}>`);
    if (r.phone) { const p = r.phone.replace(/\D/g, ''); if (p.length >= 7) out.push([new RegExp(p.split('').join('[\\s-]?'), 'g'), `<тел ${id}>`]); }
    if (r.firstName && r.lastName) lit(`${r.firstName} ${r.lastName}`, `<получатель ${id}>`, 3);
    lit(r.lastName, `<фамилия ${id}>`, 3);
  }
  for (const c of sec?.cards ?? []) { lit(c.name, `<имя на карте ${c.id}>`, 3); lit(c.billing.street, `<адрес ${c.id}>`, 5); }
  for (const p of sec?.proxies ?? []) {
    try { const u = new URL(p.url); if (u.password) lit(decodeURIComponent(u.password), '<пароль прокси>', 3); if (u.username) lit(decodeURIComponent(u.username), '<логин прокси>', 3); } catch { /* */ }
  }
  lit(sec?.telegram.botToken, '<токен Telegram>', 8);
  for (const w of sec?.webhooks ?? []) lit(w.secret, '<секрет вебхука>', 6);
  for (const t of extraTokens) lit(t, '<токен>', 8);
  // на всякий случай: любые 15–19 цифр, проходящие проверку Луна (метки времени — 13 цифр, их не трогаем)
  out.push([/\b\d(?:[ -]?\d){14,18}\b/g, (m: string) => { const d = m.replace(/\D/g, ''); return luhn(d) ? `****${d.slice(-4)}` : m; }]);
  return out;
}

export function maskText(text: string, rules: Rule[]): string {
  let t = text;
  for (const [re, to] of rules) t = typeof to === 'string' ? t.replace(re, to) : t.replace(re, to);
  return t;
}

function tailText(path: string, max = TEXT_MAX): string {
  const buf = readFileSync(path);
  return (buf.length > max ? '…(начало обрезано)\n' : '') + buf.subarray(Math.max(0, buf.length - max)).toString('utf8');
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    try { if (statSync(p).isDirectory()) out.push(...listFiles(p)); else out.push(p); } catch { /* */ }
  }
  return out;
}

/** Собрать архив; путь к .zip (или .tar.gz). */
export function buildDiag(cfg: BotConfig, sec: Secrets | null, root: string, opts: { outDir?: string } = {}): string {
  const rt = resolve(root, cfg.runtimeDir);
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const name = `applebot-logs-${cfg.machine}-${stamp}`;
  const work = join(tmpdir(), name);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  let state: any = null;
  try { state = JSON.parse(readFileSync(join(rt, 'state.json'), 'utf8')); } catch { /* */ }
  const tokens = [state?.dashToken, ...Object.values(state?.browsers ?? {}).map((b: any) => b?.token)].filter((t): t is string => typeof t === 'string');
  const rules = secretsToMask(sec, tokens);
  const put = (rel: string, text: string) => { const p = join(work, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, maskText(text, rules)); };

  // сводка
  const chrome = findChrome(cfg.fleet.chromePath, root);
  put('summary.txt', [
    `Apple Drop Bot ${BOT_VERSION}`,
    `собрано: ${new Date().toString()}`,
    `машина: ${cfg.machine} · ${platform()} ${release()} ${arch()} · Node ${process.version}`,
    `Chrome: ${chrome ? `${chrome.kind} ${chromeVersion(chrome.path) ?? ''} — ${chrome.path}` : 'не найден'}`,
    `openAt: ${cfg.openAt} · браузеров: ${cfg.fleet.browsers} · прокси: ${cfg.proxies.mode} · пробный прогон: ${cfg.payment.stopBeforePay}`,
    `заказы: ${cfg.orders.map((o) => `${o.id} ${o.targets.join('/')} ${o.payment}`).join('; ')}`,
  ].join('\n') + '\n');
  // конфиг без секретов
  put('bot.config.json', JSON.stringify(cfg, null, 2));
  // логи и состояние
  for (const f of ['hub.log', 'orchestrator.log', 'notify.txt', 'events.ndjson']) {
    const p = join(rt, f);
    if (existsSync(p)) put(f, tailText(p));
  }
  if (state) put('state.json', JSON.stringify(state, null, 1));
  for (const p of listFiles(join(rt, 'logs'))) put(join('logs', basename(p)), tailText(p, 2 * 1024 * 1024));
  // снимки страниц (заглушки, 404, страницы, где звали человека) — последние 40
  const snaps = listFiles(join(rt, 'snapshots')).map((p) => ({ p, t: statSync(p).mtimeMs })).sort((a, b) => b.t - a.t).slice(0, 40);
  for (const { p } of snaps) {
    const rel = join('snapshots', p.slice(join(rt, 'snapshots').length + 1));
    if (/\.(png|jpe?g)$/i.test(p)) { mkdirSync(join(work, rel, '..'), { recursive: true }); copyFileSync(p, join(work, rel)); } else put(rel, tailText(p, 3 * 1024 * 1024));
  }

  const dest = opts.outDir ?? (existsSync(join(homedir(), 'Desktop')) ? join(homedir(), 'Desktop') : rt);
  mkdirSync(dest, { recursive: true });
  const zip = join(dest, `${name}.zip`);
  rmSync(zip, { force: true });
  const z = spawnSync('zip', ['-qr', zip, name], { cwd: tmpdir() });
  let out = zip;
  if (z.status !== 0) {
    out = join(dest, `${name}.tar.gz`);
    spawnSync('tar', ['-czf', out, name], { cwd: tmpdir() });
  }
  rmSync(work, { recursive: true, force: true });
  return out;
}
