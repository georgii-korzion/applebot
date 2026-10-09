// Проверка fleet.json без запуска хаба: node hub/check.mjs [путь/к/fleet.json]
// Печатает по каждому профилю: сервер, стратегию, оплату, прокси (без пароля), цели, ошибки/предупреждения валидации.
// Код выхода 1, если есть ошибки — удобно запускать перед `POST /api/reload` и в день дропа.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildAll, parseFleet, profileIds } from './config.mjs';

const file = resolve(process.argv[2] ?? process.env.FLEET_FILE ?? 'fleet.json');
let text;
try { text = readFileSync(file, 'utf8'); } catch (e) { console.error(`fleet.json не прочитан (${file}): ${e.message}`); process.exit(1); }
let parsed;
try { parsed = parseFleet(text); } catch (e) { console.error(e.message); process.exit(1); }
const { fleet, hash } = parsed;
const openAt = Date.parse(fleet.openAt);
const all = buildAll(fleet, { version: Number(fleet.version) || 0, hash });
const ids = profileIds(fleet);
const mask = (p) => (p ? `${p.scheme}://${p.host}:${p.port}${p.username ? ' (с логином)' : ''}` : 'напрямую');
const byServer = new Map();
let bad = 0;
console.log(`${file}\nv${fleet.version ?? '—'} · ${hash.slice(0, 8)} · openAt ${fleet.openAt}${Number.isFinite(openAt) ? ` (${Math.round((openAt - Date.now()) / 60000)} мин от сейчас)` : ' — НЕ РАЗБИРАЕТСЯ'} · профилей ${ids.length}\n`);
for (const id of ids) {
  const { config: c, validation: v } = all[id];
  const o = c.orders[0];
  const srv = id.includes('-') ? id.slice(0, id.indexOf('-')) : id;
  byServer.set(srv, (byServer.get(srv) ?? 0) + 1);
  const card = o.payment === 'manual' ? (o.card.number ? ` карта ****${o.card.number.slice(-4)}` : ' карта НЕ задана') : '';
  console.log(`${id.padEnd(12)} ${c.strategy.padEnd(7)} ${o.payment.padEnd(8)}${card.padEnd(18)} ${mask(c.proxy).padEnd(36)} ${o.targets.join(',')} · ${o.contact.firstName} ${o.contact.lastName}${c.autoStart ? '' : ' · autoStart выкл'}`);
  for (const e of v.errors) console.log(`    ✗ ${e}`);
  for (const w of v.warnings) console.log(`    ! ${w}`);
  if (v.errors.length) bad++;
}
console.log(`\nпо серверам: ${[...byServer].map(([s, n]) => `${s}×${n}`).join(', ')}`);
if (!Number.isFinite(openAt)) { console.log('✗ openAt не разбирается'); bad++; }
const proxies = new Map();
for (const id of ids) { const p = all[id].config.proxy; if (p) proxies.set(`${p.host}:${p.port}`, (proxies.get(`${p.host}:${p.port}`) ?? 0) + 1); }
for (const [k, n] of proxies) if (n > 3) console.log(`! прокси ${k} у ${n} профилей — больше 3 на один IP до проверки не ставить (FLEET-SPEC §13.2)`);
const direct = ids.filter((id) => !all[id].config.proxy).length;
if (direct > 3) console.log(`! без прокси ${direct} профилей — с одного IP сервера больше 3 до проверки F2 не ставить (§13.2)`);
console.log(bad ? `\nОШИБКИ в ${bad} профилях — хаб ответит им 422, расширение не стартует` : '\nвсё в порядке');
process.exit(bad ? 1 : 0);
