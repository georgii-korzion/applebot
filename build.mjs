// Сборка расширения в dist/ (prod) или dist-dev/ (dev: + мок http://127.0.0.1:4777).
//   node build.mjs            → dist/
//   node build.mjs --dev      → dist-dev/
//   node build.mjs --dev --watch
//   node build.mjs --unit     → dist-test/ (юнит-тесты для node --test)
import * as esbuild from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const dev = args.has('--dev');
const watch = args.has('--watch');
const MOCK_ORIGIN = 'http://127.0.0.1:4777';

if (args.has('--unit')) {
  const out = join(root, 'dist-test');
  rmSync(out, { recursive: true, force: true });
  await esbuild.build({
    entryPoints: [join(root, 'test/unit.test.ts')],
    outfile: join(out, 'unit.test.mjs'),
    bundle: true, platform: 'node', format: 'esm', target: 'node20',
    define: { __DEV__: 'true', __DEFAULT_BASE_URL__: JSON.stringify(MOCK_ORIGIN) },
    logLevel: 'warning',
  });
  process.exit(0);
}

const outdir = join(root, dev ? 'dist-dev' : 'dist');
rmSync(outdir, { recursive: true, force: true });
mkdirSync(join(outdir, 'icons'), { recursive: true });

const define = {
  __DEV__: String(dev),
  __DEFAULT_BASE_URL__: JSON.stringify(dev ? MOCK_ORIGIN : 'https://www.apple.com'),
};
const common = { bundle: true, target: 'chrome120', define, logLevel: 'info', sourcemap: dev ? 'inline' : false, minifySyntax: !dev, legalComments: 'none' };

const builds = [
  { entryPoints: [join(root, 'src/content/index.ts')], outfile: join(outdir, 'content.js'), format: 'iife' },
  { entryPoints: [join(root, 'src/sw/index.ts')], outfile: join(outdir, 'sw.js'), format: 'esm' },
  { entryPoints: [join(root, 'src/ui/popup.ts')], outfile: join(outdir, 'popup.js'), format: 'iife' },
  { entryPoints: [join(root, 'src/ui/options.ts')], outfile: join(outdir, 'options.js'), format: 'iife' },
  { entryPoints: [join(root, 'src/ui/offscreen.ts')], outfile: join(outdir, 'offscreen.js'), format: 'iife' },
];

function writeStatic() {
  for (const f of ['popup.html', 'options.html', 'offscreen.html', 'ui.css']) {
    copyFileSync(join(root, 'src/ui', f), join(outdir, f));
  }
  const manifest = JSON.parse(readFileSync(join(root, 'src/manifest.json'), 'utf8'));
  manifest.icons = { 16: 'icons/icon16.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' };
  manifest.action.default_icon = manifest.icons;
  if (dev) {
    manifest.name += ' (dev)';
    manifest.host_permissions.push(`${MOCK_ORIGIN}/*`);
    manifest.content_scripts[0].matches.push(`${MOCK_ORIGIN}/*`);
  }
  writeFileSync(join(outdir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  for (const s of [16, 48, 128]) writeFileSync(join(outdir, `icons/icon${s}.png`), makeIcon(s));
}

// ---------- PNG-иконка без внешних файлов ----------
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function makeIcon(size) {
  const px = Buffer.alloc(size * (size * 4 + 1));
  const r = size * 0.22, c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    px[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const i = y * (size * 4 + 1) + 1 + x * 4;
      // скруглённый квадрат
      const dx = Math.max(Math.abs(x - c) - (c - r), 0), dy = Math.max(Math.abs(y - c) - (c - r), 0);
      const inside = Math.hypot(dx, dy) <= r;
      const d = Math.hypot(x - c, y - c);
      let col = [0, 0, 0, 0];
      if (inside) col = [29, 29, 31, 255];
      if (inside && d <= size * 0.34) col = [48, 209, 88, 255];
      if (inside && d <= size * 0.14) col = [255, 255, 255, 255];
      px.set(col, i);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(px)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

if (watch) {
  for (const b of builds) {
    const ctx = await esbuild.context({ ...common, ...b });
    await ctx.watch();
  }
  writeStatic();
  console.log(`watching → ${outdir}`);
} else {
  await Promise.all(builds.map((b) => esbuild.build({ ...common, ...b })));
  writeStatic();
  console.log(`built → ${outdir}${existsSync(outdir) ? '' : ' (?)'}`);
}
