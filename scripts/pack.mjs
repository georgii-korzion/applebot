// Архив расширения для серверов: dist.zip (внутри — содержимое dist/, manifest.json в корне).
//   npm run pack            → dist.zip в корне репозитория
//   OUT=/путь/x.zip npm run pack
// На сервере: распаковать в C:\drop\ext (должен получиться C:\drop\ext\manifest.json), дальше fleet.ps1 init.
// Расширения с запечённым профилем (без хаба, по папке на браузер) — scripts/bake-profiles.mjs.
import { readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileKb, zipDir } from './zip.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, 'dist');
const out = process.env.OUT ? process.env.OUT : join(root, 'dist.zip');

try { statSync(join(src, 'manifest.json')); } catch { console.error('нет dist/manifest.json — сначала node build.mjs'); process.exit(1); }
const n = zipDir(src, out);
const manifest = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8'));
console.log(`готово: ${out} · ${n} файлов · расширение v${manifest.version} · ${fileKb(out)} КБ`);
