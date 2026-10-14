// Zip папки без внешних зависимостей (deflate из zlib) — одинаково на Mac/Windows/Linux. Используют pack.mjs и bake-profiles.mjs.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { deflateRawSync } from 'node:zlib';

const CRC = new Int32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c; }
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };

export function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name !== '.DS_Store') acc.push(p);
  }
  return acc;
}

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

/**
 * Запаковать папку src в zip-файл out. prefix — папка внутри архива ('' — содержимое src в корне архива,
 * 'ext-nl1-p01' — всё внутри такой папки). Возвращает число файлов.
 */
export function zipDir(src, out, { prefix = '' } = {}) {
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  const files = walk(src).sort();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const rel = relative(src, f).split('\\').join('/');
    const name = Buffer.from(prefix ? `${prefix.replace(/\/$/, '')}/${rel}` : rel, 'utf8');
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
  return files.length;
}

export const fileKb = (f) => (statSync(f).size / 1024).toFixed(0);
