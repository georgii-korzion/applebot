// Архив расширения для серверов: dist.zip (внутри — содержимое dist/, manifest.json в корне).
//   npm run pack            → dist.zip в корне репозитория
//   OUT=/путь/x.zip npm run pack
// На сервере: распаковать в C:\drop\ext (должен получиться C:\drop\ext\manifest.json), дальше fleet.ps1 init.
// Zip пишется без внешних зависимостей (deflate из zlib), чтобы собиралось одинаково на Mac/Windows/Linux.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, 'dist');
const out = process.env.OUT ? process.env.OUT : join(root, 'dist.zip');

try { statSync(join(src, 'manifest.json')); } catch { console.error('нет dist/manifest.json — сначала node build.mjs'); process.exit(1); }

const CRC = new Int32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c; }
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };

function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name !== '.DS_Store') acc.push(p);
  }
  return acc;
}

const now = new Date();
const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

const files = walk(src).sort();
const locals = [];
const centrals = [];
let offset = 0;
for (const f of files) {
  const name = Buffer.from(relative(src, f).split('\\').join('/'), 'utf8');
  const data = readFileSync(f);
  const comp = deflateRawSync(data, { level: 9 });
  const useDeflate = comp.length < data.length;
  const body = useDeflate ? comp : data;
  const method = useDeflate ? 8 : 0;
  const crc = crc32(data);
  const head = Buffer.concat([u32(0x04034b50), u16(20), u16(0x0800), u16(method), u16(dosTime), u16(dosDate), u32(crc), u32(body.length), u32(data.length), u16(name.length), u16(0), name]);
  locals.push(head, body);
  centrals.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(method), u16(dosTime), u16(dosDate), u32(crc), u32(body.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]));
  offset += head.length + body.length;
}
const central = Buffer.concat(centrals);
const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(central.length), u32(offset), u16(0)]);
writeFileSync(out, Buffer.concat([...locals, central, end]));
const manifest = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8'));
console.log(`готово: ${out} · ${files.length} файлов · расширение v${manifest.version} · ${(statSync(out).size / 1024).toFixed(0)} КБ`);
