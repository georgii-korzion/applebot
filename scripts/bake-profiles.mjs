// Расширение с запечённым профилем — запуск без хаба и без серверов: по папке расширения на каждый браузер
// (Chrome → chrome://extensions → режим разработчика → «Загрузить распакованное»). Конфиг профиля лежит внутри
// папки в profile.json, расширение применяет его само при первом запуске (SW, applyBakedConfig).
//
//   node scripts/bake-profiles.mjs accounts.csv                 таблица (как fleet.example.csv) → out/profiles/
//   node scripts/bake-profiles.mjs fleet.json                   готовый fleet.json
//   --base fleet.example.json   база верха/defaults для CSV (по умолчанию fleet.example.json в корне)
//   --out DIR                   куда класть (по умолчанию out/profiles)
//   --hub wss://host/ws?token=… вписать хаб (профили будут отчитываться; по умолчанию — без хаба)
//   --version N                 версия конфига (по умолчанию из файла или 1)
//   --only id1,id2              только эти профили
//   --no-zip                    без zip-архивов (только папки)
//   --no-build / --dist DIR     не собирать dist/ заново / взять другую сборку (dist-dev для теста на моке)
//   --force                     собрать и профили с ошибками валидации (по умолчанию они пропускаются)
//
// На выходе: out/profiles/<id>/ (папка расширения, manifest.json в корне), out/profiles/<id>.zip, out/profiles/ALL.zip
// (все папки), out/profiles/INDEX.csv (кому какая папка) и README.txt (как загрузить). Папка out/ в .gitignore:
// внутри карты и пароли прокси открытым текстом — после дропа удалить.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileKb, zipDir } from './zip.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const README = `Apple Drop Assistant — расширения с запечённым профилем (без хаба)

В каждой папке <id>/ — своё расширение с данными одного профиля (profile.json: контакт, карта, прокси, цели, магазины).
Одна папка = один браузер (отдельный профиль Chrome или отдельный компьютер). Папку не переименовывать и не чистить.

Как загрузить (на каждом браузере, ~2 минуты):
 1. Chrome → меню профиля → «Добавить профиль» (новый, без входа в Google) — или отдельный компьютер.
 2. chrome://extensions → включить «Режим разработчика» (справа сверху) → «Загрузить распакованное» → выбрать папку <id>.
    Имя расширения заканчивается на (<id>) — так видно, какой профиль в каком окне.
 3. Открыть https://www.apple.com/ae/shop/buy-iphone/iphone-18-pro — в popup расширения должен быть профиль <id>,
    заказ, прокси и IP (если прокси задан; «IP: … AE»).
 4. Popup → Prepare (проверка страны, корзины, страницы товара). Start нажимать не нужно: autoStart взведёт гонку сам
    при запуске браузера за час до openAt (или нажать Start руками — тоже можно).
 5. Окно не закрывать. На дропе расширение само: ждёт openAt, Add to Bag, корзина, самовывоз, контакты, карта/Apple Pay.
    Человек: подтвердить оплату (Apple Pay — QR на телефоне; карта — Place Order и подтверждение банка).

Если popup пишет «профиль не назначен» — папка загружена не та (нет profile.json) или расширение не перезапустилось:
chrome://extensions → кнопка «обновить» у расширения.

После дропа: удалить расширение из браузера и папки с этого компьютера — внутри карта и пароль прокси.
`;

function parseArgs(argv) {
  const opt = { base: '', out: 'out/profiles', hub: undefined, version: undefined, only: null, zip: true, build: true, dist: 'dist', force: false, input: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') opt.base = argv[++i];
    else if (a === '--out') opt.out = argv[++i];
    else if (a === '--hub') opt.hub = argv[++i];
    else if (a === '--version') opt.version = Number(argv[++i]);
    else if (a === '--only') opt.only = argv[++i].split(',').map((x) => x.trim()).filter(Boolean);
    else if (a === '--no-zip') opt.zip = false;
    else if (a === '--no-build') opt.build = false;
    else if (a === '--dist') opt.dist = argv[++i];
    else if (a === '--force') opt.force = true;
    else if (a === '-h' || a === '--help' || a.startsWith('-')) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n')); process.exit(a === '-h' || a === '--help' ? 0 : 1); }
    else opt.input = a;
  }
  return opt;
}

const hashOf = (obj) => createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
const esc = (v) => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const maskProxy = (p) => (p ? `${p.scheme}://${p.username ? '***@' : ''}${p.host}:${p.port}` : 'напрямую');

/**
 * Собрать папки расширений по профилям fleet. built — готовые конфиги из buildAll (hub/config.mjs).
 * @returns {{ ok: string[], bad: Record<string, string[]>, skipped: string[] }}
 */
export function bakeAll(built, { distDir, outDir, only = null, zip = true, force = false }) {
  if (!existsSync(join(distDir, 'manifest.json'))) throw new Error(`нет ${join(distDir, 'manifest.json')} — сначала node build.mjs`);
  mkdirSync(outDir, { recursive: true });
  const ok = [];
  const bad = {};
  const skipped = [];
  const index = [['profile', 'firstName', 'lastName', 'payment', 'proxy', 'strategy', 'targets', 'folder']];
  for (const [id, r] of Object.entries(built)) {
    if (only && !only.includes(id)) { skipped.push(id); continue; }
    if (r.validation.errors.length) { bad[id] = r.validation.errors; if (!force) continue; }
    const dir = join(outDir, id);
    rmSync(dir, { recursive: true, force: true });
    cpSync(distDir, dir, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    manifest.name = `${manifest.name} (${id})`; // «Apple Drop Assistant (nl1-p01)» — видно в chrome://extensions и в заголовке popup
    writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const config = r.config;
    const hash = hashOf(config);
    writeFileSync(join(dir, 'profile.json'), `${JSON.stringify({ profileId: id, hash, bakedAt: new Date().toISOString(), config }, null, 2)}\n`);
    if (zip) zipDir(dir, join(outDir, `${id}.zip`), { prefix: id });
    const o = config.orders[0] ?? {};
    index.push([id, o.contact?.firstName, o.contact?.lastName, o.payment, maskProxy(config.proxy), config.strategy, (o.targets ?? []).join(' '), `${id}/`]);
    ok.push(id);
  }
  writeFileSync(join(outDir, 'INDEX.csv'), `\ufeff${index.map((row) => row.map(esc).join(';')).join('\n')}\n`);
  writeFileSync(join(outDir, 'README.txt'), README);
  if (zip && ok.length) {
    // общий архив: каждая папка профиля внутри — без zip-файлов профилей (их содержимое то же самое)
    const tmp = join(outDir, '.all');
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    for (const id of ok) cpSync(join(outDir, id), join(tmp, id), { recursive: true });
    cpSync(join(outDir, 'INDEX.csv'), join(tmp, 'INDEX.csv'));
    cpSync(join(outDir, 'README.txt'), join(tmp, 'README.txt'));
    zipDir(tmp, join(outDir, 'ALL.zip'));
    rmSync(tmp, { recursive: true, force: true });
  }
  return { ok, bad, skipped };
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (!opt.input) { console.error('нужен путь к таблице или fleet.json: node scripts/bake-profiles.mjs accounts.csv'); process.exit(1); }
  if (opt.build) {
    console.log('сборка расширения (dist/) и hub/lib/shared.mjs …');
    execFileSync(process.execPath, [join(root, 'build.mjs')], { stdio: 'inherit' });
    execFileSync(process.execPath, [join(root, 'build.mjs'), '--hub'], { stdio: 'inherit' });
  }
  const distDir = resolve(root, opt.dist);
  const distManifest = join(distDir, 'manifest.json');
  if (!existsSync(distManifest)) throw new Error(`нет ${distManifest} — сначала node build.mjs${opt.dist === 'dist' ? '' : ` --dev`}`);
  // dev-сборка (мок apple.com для e2e): валидация хаба должна пропускать baseUrl мока, как HUB_ALLOW_MOCK у хаба
  if (/\(dev\)$/.test(JSON.parse(readFileSync(distManifest, 'utf8')).name)) process.env.HUB_ALLOW_MOCK = '1';
  const { buildAll, fleetHash, parseFleet, profileIds } = await import('../hub/config.mjs');
  const { fleetFromRows, parseCsv } = await import('../hub/fleet-from-csv.mjs');
  const input = resolve(opt.input);
  const text = readFileSync(input, 'utf8');
  let fleet;
  const warnings = [];
  if (/\.(csv|tsv|txt)$/i.test(input)) {
    const baseFile = resolve(opt.base || join(root, 'fleet.example.json'));
    const base = JSON.parse(readFileSync(baseFile, 'utf8'));
    const r = fleetFromRows(parseCsv(text), base, { version: Number.isFinite(opt.version) ? opt.version : undefined });
    fleet = r.fleet;
    warnings.push(...r.warnings);
    console.log(`таблица ${basename(input)} + база ${basename(baseFile)}`);
  } else {
    fleet = parseFleet(text).fleet;
    if (Number.isFinite(opt.version)) fleet.version = opt.version;
  }
  if (opt.hub !== undefined) fleet.hubUrl = opt.hub;
  else if (!fleet.hubUrl) fleet.hubUrl = '';
  const version = Number(fleet.version) || 1;
  const built = buildAll(fleet, { hubUrl: fleet.hubUrl, version, hash: fleetHash(JSON.stringify(fleet)) });
  const outDir = resolve(opt.out);
  const { ok, bad, skipped } = bakeAll(built, { distDir, outDir, only: opt.only, zip: opt.zip, force: opt.force });
  for (const w of warnings) console.log(`  ! ${w}`);
  for (const [id, errs] of Object.entries(bad)) for (const e of errs) console.log(`  ✗ ${id}: ${e}${opt.force ? ' (собран с --force)' : ' — пропущен'}`);
  console.log(`\n${outDir}: собрано ${ok.length} из ${profileIds(fleet).length} профилей${skipped.length ? ` (пропущено по --only: ${skipped.length})` : ''} · конфиг v${version} · ${fleet.hubUrl ? `хаб ${fleet.hubUrl.replace(/token=[^&]+/, 'token=***')}` : 'без хаба'}`);
  for (const id of ok) console.log(`  ${id}/${opt.zip ? `  ${id}.zip` : ''}`);
  if (opt.zip && ok.length) console.log(`  ALL.zip — все папки одним архивом (${fileKb(join(outDir, 'ALL.zip'))} КБ) · INDEX.csv · README.txt`);
  const badLeft = Object.keys(bad).filter((id) => !opt.force).length;
  process.exit(badLeft ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1); });
