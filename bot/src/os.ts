// macOS: вывод окна вперёд по PID, клик средствами ОС, снимок экрана, звук (BOT-SPEC §9.2, §10).
// На других ОС — ничего не делает (тесты на Linux).
import { execFile, spawnSync } from 'node:child_process';
import { platform } from 'node:os';

const MAC = platform() === 'darwin';

function run(cmd: string, args: string[], timeoutMs = 5000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || stderr || err?.message || '') }));
  });
}

/** Окно процесса Chrome на передний план (нужно разрешение «Автоматизация» для Терминала). */
export async function activatePid(pid: number): Promise<boolean> {
  if (!MAC || !pid) return false;
  const r = await run('osascript', ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`]);
  return r.ok;
}

/** Клик левой кнопкой в экранных координатах (точки) через CoreGraphics; нужно разрешение «Универсальный доступ». */
export async function osClick(x: number, y: number): Promise<{ ok: boolean; error?: string }> {
  if (!MAC) return { ok: false, error: 'ОС-клик только на macOS' };
  const js = `ObjC.import('CoreGraphics');
var p = $.CGPointMake(${Math.round(x)}, ${Math.round(y)});
var mv = $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, p, $.kCGMouseButtonLeft); $.CGEventPost($.kCGHIDEventTap, mv);
delay(0.05);
var d = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, p, $.kCGMouseButtonLeft); $.CGEventPost($.kCGHIDEventTap, d);
delay(0.06);
var u = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, p, $.kCGMouseButtonLeft); $.CGEventPost($.kCGHIDEventTap, u);
'ok';`;
  const r = await run('osascript', ['-l', 'JavaScript', '-e', js]);
  return r.ok ? { ok: true } : { ok: false, error: r.out.slice(0, 200) };
}

/** Снимок области экрана (если QR в системном окне, которого CDP не видит). */
export async function screencapture(file: string, rect?: { x: number; y: number; w: number; h: number }): Promise<boolean> {
  if (!MAC) return false;
  const args = ['-x'];
  if (rect) args.push('-R', `${rect.x},${rect.y},${rect.w},${rect.h}`);
  args.push(file);
  return (await run('screencapture', args)).ok;
}

export function beep(kind: 'attention' | 'done' = 'attention'): void {
  if (!MAC) return;
  const f = kind === 'done' ? '/System/Library/Sounds/Glass.aiff' : '/System/Library/Sounds/Sosumi.aiff';
  execFile('afplay', [f], () => {});
}

export function caffeinateRunning(): boolean | null {
  if (!MAC) return null;
  const r = spawnSync('pgrep', ['-x', 'caffeinate'], { encoding: 'utf8' });
  return r.status === 0;
}

/** Размер экрана в точках (для плитки окон). */
export function screenSize(): { width: number; height: number } | null {
  if (!MAC) return null;
  const r = spawnSync('osascript', ['-e', 'tell application "Finder" to get bounds of window of desktop'], { encoding: 'utf8', timeout: 5000 });
  const m = /(-?\d+),\s*(-?\d+),\s*(\d+),\s*(\d+)/.exec(r.stdout ?? '');
  return m ? { width: Number(m[3]), height: Number(m[4]) } : null;
}

/** Свободная память, МБ (macOS: free + inactive + speculative из vm_stat; иначе os.freemem). */
export function freeMemMb(fallback: number): number {
  if (!MAC) return fallback;
  const r = spawnSync('vm_stat', [], { encoding: 'utf8' });
  const page = Number(/page size of (\d+)/.exec(r.stdout ?? '')?.[1] ?? 16384);
  const get = (k: string) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(r.stdout ?? '')?.[1] ?? 0);
  const pages = get('Pages free') + get('Pages inactive') + get('Pages speculative') + get('Pages purgeable');
  return pages ? Math.round((pages * page) / 1048576) : fallback;
}

export function systemLanguage(): string {
  if (MAC) {
    const r = spawnSync('defaults', ['read', '-g', 'AppleLanguages'], { encoding: 'utf8' });
    const m = /"?([a-z]{2}(-[A-Z]{2})?)"?/.exec(r.stdout ?? '');
    if (m) return m[1];
  }
  return process.env.LANG ?? '';
}
