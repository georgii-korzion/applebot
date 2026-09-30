// Options (§7.9): форма заказа + JSON-редактор с валидацией, импорт/экспорт, адрес хаба.
import { K, defaultConfig, defaultOrder, normalizeConfig, validateConfig, type Config, type OrderCfg } from '../shared/config';
import { PARTS, partLabel } from '../shared/parts';

const $ = <T extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as T;

let cfg: Config = defaultConfig();
let cur = 0;

const list = (s: string) => s.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);

function orderToForm(o: OrderCfg): void {
  $('o_id').value = o.id;
  $('o_priority').value = String(o.priority);
  $('o_profiles').value = o.profiles.join(', ');
  $('o_racers').value = String(o.racersPerProfile);
  $('o_targets').value = o.targets.join(', ');
  $('o_stores').value = o.stores.join(', ');
  $<HTMLSelectElement>('o_city').value = o.city;
  $('o_day').value = o.slot.day ?? '';
  $('o_after').value = o.slot.after ?? '';
  $('o_before').value = o.slot.before ?? '';
  $<HTMLSelectElement>('o_payment').value = o.payment;
  $<HTMLSelectElement>('o_apfb').value = o.applePayFallback ?? '';
  $<HTMLSelectElement>('o_cardfb').value = o.cardFallback ?? '';
  $('o_first').value = o.contact.firstName;
  $('o_last').value = o.contact.lastName;
  $('o_email').value = o.contact.email;
  $('o_phone').value = o.contact.phone;
  $('o_cardnum').value = o.card.number;
  $('o_cardexp').value = o.card.expiry;
  $('o_cardcvv').value = o.card.cvv;
  $('o_cardname').value = o.card.name;
  $('o_bfirst').value = o.billing.firstName;
  $('o_blast').value = o.billing.lastName;
  $('o_bstreet').value = o.billing.street;
  $('o_barea').value = o.billing.area;
  $('o_btown').value = o.billing.town;
  $<HTMLSelectElement>('o_bcity').value = o.billing.city || 'Dubai';
  $('o_btitle').value = o.billing.title;
  $('o_autoreview').checked = o.autoReview;
  $('o_autoplace').checked = o.autoPlaceOrder;
  $('o_delivery').checked = o.deliveryFallback;
  $('o_street').value = o.address.street;
  $('o_area').value = o.address.area;
  $('o_acity').value = o.address.city;
}

function formToOrder(o: OrderCfg): void {
  o.id = $('o_id').value.trim() || o.id;
  o.priority = Number($('o_priority').value) || 1;
  o.profiles = list($('o_profiles').value);
  o.racersPerProfile = Math.max(1, Number($('o_racers').value) || 1);
  o.targets = list($('o_targets').value).map((x) => x.toUpperCase());
  o.stores = list($('o_stores').value).map((x) => x.toUpperCase());
  o.city = $<HTMLSelectElement>('o_city').value;
  o.slot = { day: $('o_day').value.trim() || null, after: $('o_after').value.trim() || null, before: $('o_before').value.trim() || null };
  o.payment = $<HTMLSelectElement>('o_payment').value === 'manual' ? 'manual' : 'applepay';
  o.applePayFallback = $<HTMLSelectElement>('o_apfb').value === 'manual' ? 'manual' : null;
  o.cardFallback = $<HTMLSelectElement>('o_cardfb').value === 'applepay' ? 'applepay' : null;
  o.contact = { firstName: $('o_first').value.trim(), lastName: $('o_last').value.trim(), email: $('o_email').value.trim(), phone: $('o_phone').value.replace(/[\s-]/g, '') };
  o.card = { number: $('o_cardnum').value.replace(/[\s-]/g, ''), expiry: $('o_cardexp').value.trim(), cvv: $('o_cardcvv').value.trim(), name: $('o_cardname').value.trim() };
  o.billing = { title: $('o_btitle').value.trim(), firstName: $('o_bfirst').value.trim(), lastName: $('o_blast').value.trim(), street: $('o_bstreet').value.trim(), area: $('o_barea').value.trim(), town: $('o_btown').value.trim(), city: $<HTMLSelectElement>('o_bcity').value || 'Dubai' };
  o.autoReview = $('o_autoreview').checked;
  o.autoPlaceOrder = $('o_autoplace').checked;
  o.deliveryFallback = $('o_delivery').checked;
  o.address = { street: $('o_street').value.trim(), area: $('o_area').value.trim(), city: $('o_acity').value.trim() || 'Dubai' };
}

function render(): void {
  $('profileId').value = cfg.profileId;
  $('hubUrl').value = cfg.hubUrl;
  $('openAt').value = cfg.openAt;
  $<HTMLSelectElement>('mode').value = cfg.mode;
  $('baseUrl').value = cfg.baseUrl;
  const sel = $<HTMLSelectElement>('orderSel');
  sel.textContent = '';
  cfg.orders.forEach((o, i) => {
    const op = document.createElement('option');
    op.value = String(i);
    op.textContent = `Заказ ${o.id} · ${o.profiles.join(', ') || 'без профилей'}${o.profiles.includes(cfg.profileId) ? ' ← этот профиль' : ''}`;
    sel.append(op);
  });
  cur = Math.min(cur, cfg.orders.length - 1);
  sel.value = String(cur);
  if (cfg.orders[cur]) orderToForm(cfg.orders[cur]);
  syncJson();
}

function readForm(): void {
  cfg.profileId = $('profileId').value.trim();
  cfg.hubUrl = $('hubUrl').value.trim();
  cfg.openAt = $('openAt').value.trim();
  cfg.mode = $<HTMLSelectElement>('mode').value === 'assist' ? 'assist' : 'auto';
  cfg.baseUrl = $('baseUrl').value.trim().replace(/\/$/, '');
  if (cfg.orders[cur]) formToOrder(cfg.orders[cur]);
}

function syncJson(): void {
  if (document.activeElement === $('json')) return;
  $<HTMLTextAreaElement>('json').value = JSON.stringify(cfg, null, 2);
}

function show(text: string, cls: 'ok' | 'err' | 'warn'): void {
  const m = $('msg');
  m.hidden = false;
  m.className = `msg card ${cls}`;
  m.textContent = text;
}

async function load(): Promise<void> {
  const s = await chrome.storage.local.get([K.config, K.profileId]);
  cfg = normalizeConfig(s[K.config] ?? defaultConfig());
  if (s[K.profileId]) cfg.profileId = String(s[K.profileId]);
  cur = Math.max(0, cfg.orders.findIndex((o) => o.profiles.includes(cfg.profileId)));
  render();
}

async function save(): Promise<void> {
  readForm();
  cfg = normalizeConfig(cfg);
  const v = validateConfig(cfg);
  render();
  if (v.errors.length) {
    show(`Не сохранено. Ошибки:\n• ${v.errors.join('\n• ')}${v.warnings.length ? `\n\nПредупреждения:\n• ${v.warnings.join('\n• ')}` : ''}`, 'err');
    return;
  }
  await chrome.storage.local.set({ [K.config]: cfg, [K.profileId]: cfg.profileId });
  await chrome.storage.local.remove(K.modeOverride);
  show(`Сохранено ✓ ${new Date().toLocaleTimeString()}${v.warnings.length ? `\n• ${v.warnings.join('\n• ')}` : ''}`, v.warnings.length ? 'warn' : 'ok');
}

// ---------- события ----------
document.addEventListener('input', (e) => {
  const id = (e.target as HTMLElement).id;
  if (!id || id === 'json' || id === 'import') return;
  readForm();
  syncJson();
});
document.addEventListener('change', (e) => {
  const id = (e.target as HTMLElement).id;
  if (!id || id === 'json' || id === 'import' || id === 'orderSel') return;
  readForm();
  syncJson();
});

$<HTMLSelectElement>('orderSel').onchange = () => {
  readForm();
  cur = Number($<HTMLSelectElement>('orderSel').value);
  render();
};
$('addOrder').onclick = () => {
  readForm();
  const id = String.fromCharCode(65 + cfg.orders.length);
  cfg.orders.push({ ...defaultOrder(id), priority: cfg.orders.length + 1, profiles: [] });
  cur = cfg.orders.length - 1;
  render();
};
$('delOrder').onclick = () => {
  if (cfg.orders.length <= 1) return show('Должен остаться хотя бы один заказ', 'warn');
  cfg.orders.splice(cur, 1);
  cur = 0;
  render();
};
$('applyJson').onclick = () => {
  try {
    const raw = JSON.parse($<HTMLTextAreaElement>('json').value);
    const keepProfile = cfg.profileId;
    cfg = normalizeConfig(raw);
    cfg.profileId = keepProfile || cfg.profileId;
    cur = Math.max(0, cfg.orders.findIndex((o) => o.profiles.includes(cfg.profileId)));
    $<HTMLTextAreaElement>('json').blur();
    render();
    const v = validateConfig(cfg);
    show(v.errors.length ? `JSON применён, но есть ошибки:\n• ${v.errors.join('\n• ')}` : 'JSON применён в форму (не забудь сохранить)', v.errors.length ? 'warn' : 'ok');
  } catch (e) {
    show(`JSON не разобран: ${e}`, 'err');
  }
};
$('reset').onclick = () => {
  const keep = cfg.profileId;
  cfg = defaultConfig();
  cfg.profileId = keep;
  cur = 0;
  render();
};
$('save').onclick = () => void save();
$('export').onclick = () => {
  readForm();
  const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `apple-drop-config-${cfg.profileId}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};
$('importBtn').onclick = () => $('import').click();
$('import').onchange = async () => {
  const f = $('import').files?.[0];
  if (!f) return;
  try {
    const raw = JSON.parse(await f.text());
    const keep = $('profileId').value.trim();
    cfg = normalizeConfig(raw);
    if (keep) cfg.profileId = keep;
    cur = Math.max(0, cfg.orders.findIndex((o) => o.profiles.includes(cfg.profileId)));
    render();
    show(`Импортирован ${f.name} (profileId оставлен: ${cfg.profileId}). Проверь и сохрани.`, 'ok');
  } catch (e) {
    show(`Импорт не удался: ${e}`, 'err');
  }
  $('import').value = '';
};

// справочник партов
const parts = $('parts');
for (const p of Object.values(PARTS)) {
  const d = document.createElement('div');
  d.textContent = `${p.part} — ${partLabel(p.part)}`;
  parts.append(d);
}

void load();
