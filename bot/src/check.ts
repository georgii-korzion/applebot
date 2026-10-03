// bot check (BOT-SPEC §4, §8, §20.9): Chrome, загрузка расширения, память, часовой пояс, язык, caffeinate,
// порт хаба, прокси (выходной IP, страна, уникальность, скорость), конфиг и секреты, тестовое сообщение в Telegram.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir, freemem } from 'node:os';
import net from 'node:net';
import type { BotConfig, Secrets } from './config';
import { validateBot } from './config';
import { chromeArgs, chromeVersion, findChrome, majorOf } from './chrome';
import { Cdp } from './cdp';
import { caffeinateRunning, freeMemMb, systemLanguage } from './os';
import { httpsGetVia, parseProxyUrl, redactProxy } from './proxy/forwarder';
import { partUrl } from '../../src/shared/parts';
import { Telegram } from './notify/telegram';
import { sign } from './notify';

export interface CheckLine { level: 'ok' | 'warn' | 'err' | 'info'; text: string }

function portFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = net.createServer();
    s.once('error', () => res(false));
    s.listen(port, '127.0.0.1', () => s.close(() => res(true)));
  });
}

/** Расширение загружается: временный профиль, headless, ждём service worker расширения в CDP. */
async function extensionLoads(chrome: string, ext: string, branded: boolean): Promise<{ ok: boolean; detail: string }> {
  const prof = mkdtempSync(join(tmpdir(), 'bot-check-'));
  const port = 9290 + Math.floor(Math.random() * 9);
  const args = chromeArgs({ profileDir: prof, extDir: ext, url: 'about:blank', cdpPort: port, window: { x: 0, y: 0, width: 800, height: 600 }, headless: true, mockKeychain: true, bypassLoopback: true, branded, extraArgs: process.getuid?.() === 0 ? ['--no-sandbox'] : [] });
  const ch = spawn(chrome, args, { stdio: 'ignore' });
  try {
    const end = Date.now() + 20_000;
    while (Date.now() < end) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
        const list = (await r.json()) as { type: string; url: string }[];
        const sw = list.find((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'));
        if (sw) return { ok: true, detail: sw.url.replace(/\/sw\.js$/, '') };
      } catch { /* ещё стартует */ }
    }
    return { ok: false, detail: 'service worker расширения не появился за 20 с (--load-extension не сработал?)' };
  } finally {
    ch.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    rmSync(prof, { recursive: true, force: true });
  }
}

export async function runCheck(cfg: BotConfig, sec: Secrets, root: string, opts: { skipNet?: boolean } = {}): Promise<{ ok: boolean; lines: CheckLine[] }> {
  const L: CheckLine[] = [];
  const ok = (t: string) => L.push({ level: 'ok', text: t });
  const warn = (t: string) => L.push({ level: 'warn', text: t });
  const err = (t: string) => L.push({ level: 'err', text: t });
  const info = (t: string) => L.push({ level: 'info', text: t });

  // конфиг и секреты
  const extDir = resolve(root, cfg.fleet.extensionDir);
  let devBuild = false;
  if (existsSync(join(extDir, 'manifest.json'))) {
    const mf = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
    devBuild = /\(dev\)/.test(mf.name ?? '');
  }
  const v = validateBot(cfg, sec, { devBuild });
  if (v.errors.length) for (const e of v.errors) err(`конфиг: ${e}`); else ok(`конфиг и секреты: заказов ${cfg.orders.length}, получателей ${Object.keys(sec.recipients).length}, карт ${sec.cards.length}, прокси ${sec.proxies.length}`);
  for (const w of v.warnings) warn(`конфиг: ${w}`);
  info(`машина: ${cfg.machine}`);

  // Chrome
  const chrome = findChrome(cfg.fleet.chromePath, root);
  let branded = false;
  if (!chrome) err('Chrome не найден: npm run bot -- install-chrome (Chrome for Testing) или fleet.chromePath');
  else {
    const ver = chromeVersion(chrome.path);
    branded = chrome.kind === 'chrome';
    const major = majorOf(ver);
    if (branded && major >= 137) err(`${ver}: фирменный Chrome ≥137 не загружает расширения из командной строки — нужен Chrome for Testing (npm run bot -- install-chrome)`);
    else ok(`Chrome: ${ver ?? '?'} (${chrome.kind === 'cft' ? 'Chrome for Testing' : chrome.kind}) — ${chrome.path}`);
  }
  // сборка и загрузка расширения
  if (!existsSync(join(extDir, 'manifest.json'))) err(`нет сборки расширения ${extDir}: npm run build`);
  else {
    ok(`сборка расширения: ${cfg.fleet.extensionDir}${devBuild ? ' (dev — только для мока)' : ''}`);
    if (chrome) {
      const r = await extensionLoads(chrome.path, extDir, branded && majorOf(chromeVersion(chrome.path)) >= 137);
      if (r.ok) ok(`расширение загружается: ${r.detail}`); else err(`расширение: ${r.detail}`);
    }
  }
  // машина
  const freeMb = freeMemMb(Math.round(freemem() / 1048576));
  const need = cfg.fleet.browsers * 600;
  if (freeMb < need) warn(`свободной памяти ${freeMb} МБ < ${need} МБ (600 МБ × ${cfg.fleet.browsers} браузеров) — уменьшить fleet.browsers или закрыть программы`);
  else ok(`память: свободно ${freeMb} МБ (нужно ~${need} МБ)`);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (tz !== 'Asia/Dubai') warn(`часовой пояс системы ${tz}, нужен Asia/Dubai (Системные настройки → Основные → Дата и время)`); else ok('часовой пояс: Asia/Dubai');
  const lang = systemLanguage();
  if (lang && !/^en/i.test(lang)) info(`язык системы ${lang} — браузеры запускаются с --lang=en-US`); else ok(`язык: ${lang || 'en'}`);
  const caf = caffeinateRunning();
  if (caf === false) warn('caffeinate не запущен: в отдельном Терминале `caffeinate -d` (Mac не должен засыпать)');
  else if (caf) ok('caffeinate запущен');
  // хаб
  if (await portFree(cfg.hub.port)) ok(`порт хаба ${cfg.hub.port} свободен`);
  else {
    const alive = await fetch(`http://127.0.0.1:${cfg.hub.port}/health`).then((r) => r.ok).catch(() => false);
    if (alive) warn(`оркестратор уже запущен на порту ${cfg.hub.port}`); else err(`порт ${cfg.hub.port} занят другой программой — hub.port в конфиге`);
  }
  // прокси и сеть
  if (!opts.skipNet) {
    const target = cfg.orders[0]?.targets[0];
    let directMs = 0;
    try {
      const r = await httpsGetVia(null, `${cfg.baseUrl}/ae/`, 10_000);
      directMs = r.ms;
      if (r.status === 200) ok(`apple.com/ae напрямую: ${r.ms} мс`); else warn(`apple.com/ae напрямую: HTTP ${r.status} за ${r.ms} мс`);
    } catch (e) { warn(`apple.com/ae напрямую не открылся: ${e instanceof Error ? e.message : e}`); }
    const ips = new Map<string, string>();
    const results: Record<string, unknown> = {};
    for (const px of sec.proxies) {
      const name = `прокси ${px.label} (${redactProxy(px.url)})`;
      try {
        const up = parseProxyUrl(px.url);
        const ipR = await httpsGetVia(up, 'https://api.ipify.org?format=json', 10_000);
        const ip = /"ip"\s*:\s*"([^"]+)"/.exec(ipR.body)?.[1] ?? '?';
        const cc = (await httpsGetVia(up, `https://ipinfo.io/${ip}/country`, 10_000).catch(() => ({ body: '?' }))).body.trim().toUpperCase();
        const home = await httpsGetVia(up, `${cfg.baseUrl}/ae/`, 15_000);
        const prod = target ? await httpsGetVia(up, partUrl(cfg.baseUrl, target), 15_000).catch(() => ({ status: 0, ms: 0 })) : { status: 0, ms: 0 };
        results[px.id] = { ip, country: cc, ms: home.ms, status: home.status, product: prod.status };
        const notes: string[] = [];
        if (cc !== cfg.proxies.requireCountry) notes.push(`страна ${cc} ≠ ${cfg.proxies.requireCountry}`);
        if (ips.has(ip)) notes.push(`IP совпадает с ${ips.get(ip)}`);
        if (home.ms > 800) notes.push(`медленно: ${home.ms} мс > 800`);
        if (directMs && home.ms > directMs * 2) notes.push(`вдвое медленнее прямого канала — в запасные`);
        if (prod.status !== 200) notes.push(`страница товара: HTTP ${prod.status}`);
        ips.set(ip, px.label);
        const line = `${name}: IP ${ip} · ${cc} · apple.com/ae ${home.ms} мс · товар ${prod.status}`;
        if (notes.length) warn(`${line} — ${notes.join('; ')}`); else ok(line);
      } catch (e) {
        results[px.id] = { error: String(e) };
        err(`${name}: ${e instanceof Error ? e.message : e}`);
      }
    }
    try { writeFileSync(resolve(root, cfg.runtimeDir, 'proxy-check.json'), JSON.stringify({ at: Date.now(), directMs, results }, null, 1)); } catch { /* runtime ещё нет */ }
  }
  // уведомления
  if (cfg.notify.telegram.enabled && sec.telegram.botToken) {
    try {
      const tg = new Telegram(sec.telegram.botToken, sec.telegram.chatId, cfg.notify.telegram.apiBase, sec.telegram.allowedUserIds, () => undefined);
      const me = await tg.call<{ username: string }>('getMe', {});
      await tg.call('sendMessage', { chat_id: sec.telegram.chatId, text: `✓ bot check (${cfg.machine}): Telegram работает` });
      ok(`Telegram: @${me.username}, тестовое сообщение отправлено`);
    } catch (e) { err(`Telegram: ${e instanceof Error ? e.message : e}`); }
  } else info('Telegram выключен — заказы пишутся в runtime/orders.txt');
  if (cfg.notify.webhooks.enabled) {
    for (const w of sec.webhooks) {
      const body = JSON.stringify({ event: 'check', ts: new Date().toISOString(), machine: cfg.machine });
      const r = await fetch(w.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': sign(body, w.secret), 'x-event': 'check' }, body, signal: AbortSignal.timeout(8000) }).catch((e) => e as Error);
      if (r instanceof Error) err(`вебхук ${new URL(w.url).host}: ${r.message}`); else if (r.ok) ok(`вебхук ${new URL(w.url).host}: ${r.status}`); else warn(`вебхук ${new URL(w.url).host}: HTTP ${r.status}`);
    }
  }
  return { ok: !L.some((l) => l.level === 'err'), lines: L };
}
