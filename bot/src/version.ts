// Версия бота — коммит, из которого собран bot/dist/bot.mjs (build.mjs → __BOT_VERSION__).
// После git pull без перезапуска пульт и оркестратор ещё старые — пульт сравнивает с текущим коммитом папки.
import { spawnSync } from 'node:child_process';

declare const __BOT_VERSION__: string;

export const BOT_VERSION: string = typeof __BOT_VERSION__ === 'string' && __BOT_VERSION__ ? __BOT_VERSION__ : 'dev';

/** Текущий коммит в папке бота; null — не git (скачан ZIP) или git нет. */
export function headVersion(root: string): string | null {
  try {
    const r = spawnSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 3000 });
    const v = (r.stdout ?? '').trim();
    return r.status === 0 && /^[0-9a-f]{7}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}
