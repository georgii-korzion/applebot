// Поиск Chrome и аргументы запуска (BOT-SPEC §4).
// Фирменный Google Chrome с ~137 не принимает --load-extension — нужен Chrome for Testing (или Chromium) той же версии.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export interface ChromeBin { path: string; kind: 'cft' | 'chromium' | 'chrome' | 'custom' }

function globDeep(dir: string, name: string, depth = 6): string | null {
  if (!existsSync(dir) || depth < 0) return null;
  let entries: string[] = [];
  try { entries = readdirSync(dir).sort().reverse(); } catch { return null; }
  for (const e of entries) {
    const p = join(dir, e);
    try { if (e === name && statSync(p).isFile()) return p; } catch { /* */ }
  }
  for (const e of entries) {
    const p = join(dir, e);
    let sub: string | null = null;
    // .part — недораспакованная установка (install-chrome распаковывает туда, потом переименовывает)
    try { if (!e.startsWith('.') && !e.endsWith('.part')) sub = globDeep(p, name, depth - 1); } catch { /* */ }
    if (sub) return sub;
  }
  return null;
}

export function findChrome(configured: string, root: string, opts: { cftOnly?: boolean } = {}): ChromeBin | null {
  if (configured && !opts.cftOnly) return existsSync(configured) ? { path: configured, kind: /for Testing/i.test(configured) ? 'cft' : /chromium/i.test(configured) ? 'chromium' : 'custom' } : null;
  const mac = platform() === 'darwin';
  const cft = mac ? 'Google Chrome for Testing' : 'chrome';
  // npx @puppeteer/browsers install chrome@stable --path runtime/chrome
  const local = globDeep(join(root, 'runtime', 'chrome'), cft);
  if (local) return { path: local, kind: 'cft' };
  if (opts.cftOnly) {
    if (!mac) return null;
    const app = ['/Applications', join(homedir(), 'Applications')].map((d) => join(d, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')).find((p) => existsSync(p));
    return app ? { path: app, kind: 'cft' } : null;
  }
  const cands: [string, ChromeBin['kind']][] = mac ? [
    ['/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'cft'],
    [join(homedir(), 'Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'), 'cft'],
    ['/Applications/Chromium.app/Contents/MacOS/Chromium', 'chromium'],
    ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'chrome'],
  ] : [
    ['/usr/bin/chromium', 'chromium'], ['/usr/bin/chromium-browser', 'chromium'], ['/usr/bin/google-chrome', 'chrome'],
  ];
  if (!mac) {
    const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
    if (existsSync(base)) {
      for (const d of readdirSync(base).sort().reverse()) {
        const p = join(base, d, 'chrome-linux/chrome');
        if (d.startsWith('chromium-') && existsSync(p)) cands.unshift([p, 'chromium']);
      }
    }
  }
  for (const [p, kind] of cands) if (existsSync(p)) return { path: p, kind };
  return null;
}

export function chromeVersion(path: string): string | null {
  try {
    const r = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: 10_000 });
    return (r.stdout || r.stderr || '').trim() || null;
  } catch {
    return null;
  }
}

export function majorOf(version: string | null): number {
  return Number(/(\d+)\./.exec(version ?? '')?.[1] ?? 0);
}

/** Этим Chrome бот работать не сможет: фирменный Google Chrome с 137 молча игнорирует --load-extension. */
export function chromeProblem(bin: ChromeBin, version: string | null): string | null {
  if (bin.kind === 'chrome' && majorOf(version) >= 137) {
    return `найден только обычный ${version ?? 'Google Chrome'} — он не загружает расширение бота (с версии 137). Нужен Chrome for Testing: в пульте «Установить» или npm run bot -- install-chrome`;
  }
  return null;
}

export interface LaunchOpts {
  profileDir: string;
  extDir: string;
  url: string;
  proxyPort?: number;
  cdpPort?: number;
  window: { x: number; y: number; width: number; height: number };
  headless: boolean;
  mockKeychain: boolean;
  bypassLoopback: boolean;
  branded: boolean;
  extraArgs: string[];
}

export function chromeArgs(o: LaunchOpts): string[] {
  const a = [
    `--user-data-dir=${o.profileDir}`,
    `--load-extension=${o.extDir}`,
    `--disable-extensions-except=${o.extDir}`,
    '--no-first-run', '--no-default-browser-check',
    '--lang=en-US',
    `--window-size=${o.window.width},${o.window.height}`,
    `--window-position=${o.window.x},${o.window.y}`,
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ];
  if (o.proxyPort) {
    a.push(`--proxy-server=http://127.0.0.1:${o.proxyPort}`);
    // по умолчанию Chrome сам пускает 127.0.0.1 (хаб) мимо прокси; <-loopback> — только для тестов на моке
    if (!o.bypassLoopback) a.push('--proxy-bypass-list=<-loopback>');
  }
  if (o.cdpPort) a.push(`--remote-debugging-port=${o.cdpPort}`, '--remote-debugging-address=127.0.0.1');
  if (o.headless) a.push('--headless=new');
  if (o.mockKeychain && platform() === 'darwin') a.push('--use-mock-keychain');
  // фирменный Chrome 137–138 ещё понимал этот выключатель; дальше — только Chrome for Testing
  if (o.branded) a.push('--disable-features=DisableLoadExtensionCommandLineSwitch');
  a.push(...o.extraArgs, o.url);
  return a;
}
