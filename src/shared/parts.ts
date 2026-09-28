// Парт-номера и URL (§2.1, Приложение A) + магазины ОАЭ (§2.2).

export interface Part {
  part: string;       // MK254AH/A
  family: string;     // iphone-duo
  model: string;      // iPhone Duo
  display: string;    // 7.6
  capacity: string;   // 256gb
  color: string;      // night-sky
  path: string;       // /ae/shop/buy-iphone/iphone-duo/7.6-inch-display-256gb-night-sky
}

const CAPS = ['256gb', '512gb', '1tb', '2tb'] as const;

function mk(part: string, family: string, model: string, display: string, capacity: string, color: string): Part {
  return {
    part, family, model, display, capacity, color,
    path: `/ae/shop/buy-iphone/${family}/${display}-inch-display-${capacity}-${color}`,
  };
}

const DUO: Record<string, [string, string]> = {
  '256gb': ['MK244AH/A', 'MK254AH/A'],
  '512gb': ['MK264AH/A', 'MK274AH/A'],
  '1tb': ['MK284AH/A', 'MK294AH/A'],
  '2tb': ['MK2A4AH/A', 'MK2C4AH/A'],
};

// [capacity, color, 18 Pro, 18 Pro Max]
const PRO: [string, string, string, string][] = [
  ['256gb', 'black', 'MJR54AH/A', 'MJX54AH/A'],
  ['256gb', 'silver', 'MJR64AH/A', 'MJX64AH/A'],
  ['256gb', 'burgundy', 'MJR74AH/A', 'MJX74AH/A'],
  ['256gb', 'glacier', 'MJR84AH/A', 'MJX84AH/A'],
  ['512gb', 'black', 'MJR94AH/A', 'MJX94AH/A'],
  ['512gb', 'silver', 'MJRC4AH/A', 'MJXA4AH/A'],
  ['512gb', 'burgundy', 'MJRD4AH/A', 'MJXC4AH/A'],
  ['512gb', 'glacier', 'MJRE4AH/A', 'MJXD4AH/A'],
  ['1tb', 'black', 'MJRF4AH/A', 'MJXE4AH/A'],
  ['1tb', 'silver', 'MJRG4AH/A', 'MJXF4AH/A'],
  ['1tb', 'burgundy', 'MJRH4AH/A', 'MJXG4AH/A'],
  ['1tb', 'glacier', 'MJRJ4AH/A', 'MJXH4AH/A'],
  ['2tb', 'black', 'MJRK4AH/A', 'MJXJ4AH/A'],
  ['2tb', 'silver', 'MJRL4AH/A', 'MJXK4AH/A'],
  ['2tb', 'burgundy', 'MJRM4AH/A', 'MJXL4AH/A'],
  ['2tb', 'glacier', 'MJRN4AH/A', 'MJXM4AH/A'],
];

export const PARTS: Record<string, Part> = {};
for (const cap of CAPS) {
  const [white, sky] = DUO[cap];
  PARTS[white] = mk(white, 'iphone-duo', 'iPhone Duo', '7.6', cap, 'star-white');
  PARTS[sky] = mk(sky, 'iphone-duo', 'iPhone Duo', '7.6', cap, 'night-sky');
}
for (const [cap, color, pro, max] of PRO) {
  PARTS[pro] = mk(pro, 'iphone-18-pro', 'iPhone 18 Pro', '6.3', cap, color);
  PARTS[max] = mk(max, 'iphone-18-pro', 'iPhone 18 Pro Max', '6.9', cap, color);
}

export function normPart(p: string | null | undefined): string {
  return String(p ?? '').trim().toUpperCase();
}

export function getPart(p: string): Part | undefined {
  return PARTS[normPart(p)];
}

export function partUrl(baseUrl: string, p: string): string {
  const part = getPart(p);
  if (!part) throw new Error(`unknown part ${p}`);
  return baseUrl.replace(/\/$/, '') + part.path;
}

/** Парт по пути страницы конфигурации (`/ae/shop/buy-iphone/<family>/<slug>`). */
export function partByPath(pathname: string): Part | undefined {
  const clean = pathname.replace(/\/$/, '').toLowerCase();
  return Object.values(PARTS).find((p) => p.path === clean);
}

export function capLabel(cap: string): string {
  return cap.toUpperCase();
}

export function colorLabel(color: string): string {
  return color.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

export function partLabel(p: string): string {
  const x = getPart(p);
  return x ? `${x.model} ${capLabel(x.capacity)} ${colorLabel(x.color)}` : p;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Совпадает ли название позиции в корзине (`bag-item-name`) с партом.
 * strict: модель + память + цвет; loose: модель + память.
 */
export function matchBagName(name: string, p: string): 'strict' | 'loose' | false {
  const part = getPart(p);
  if (!part) return false;
  const n = norm(name);
  const model = part.model.toLowerCase();
  if (!n.includes(model)) return false;
  if (!part.model.includes('Max') && n.includes('pro max')) return false;
  const capNum = part.capacity.replace(/(gb|tb)$/, '');
  const capUnit = part.capacity.slice(-2);
  if (!new RegExp(`\\b${capNum}\\s?${capUnit}\\b`).test(n)) return false;
  const colorWord = part.color.split('-')[0];
  return n.includes(colorWord) ? 'strict' : 'loose';
}

export interface Store { id: string; name: string; city: string }

export const STORES: Store[] = [
  { id: 'R597', name: 'Apple Dubai Mall', city: 'Dubai' },
  { id: 'R596', name: 'Apple Mall of the Emirates', city: 'Dubai' },
  { id: 'R706', name: 'Apple Al Maryah Island', city: 'Abu Dhabi' },
  { id: 'R595', name: 'Apple Yas Mall', city: 'Abu Dhabi' },
  { id: 'R785', name: 'Apple Al Jimi Mall (Al Ain)', city: 'Al Ain' },
];

export function storeName(id: string | undefined): string {
  return STORES.find((s) => s.id === id)?.name ?? id ?? '';
}
