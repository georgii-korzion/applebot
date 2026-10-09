// Popup (§7.9, FLEET-SPEC §5.3): статус профиля, стратегия, IP, конфиг с хаба, вкладки, Start/Stop/Prepare/Clean bag/Экспорт.
import type { Cmd, Egress, OrderRecord, OrderState, TabRow } from '../shared/messages';
import type { CfgMeta, Strategy } from '../shared/config';

interface Status {
  ok: boolean;
  profileId: string;
  server: string;
  mode: 'auto' | 'assist';
  strategy: Strategy;
  autoStart: boolean;
  openAt: string;
  baseUrl: string;
  mock: boolean;
  order: { id: string; targets: string[]; stores: string[]; payment: string; racers: number } | null;
  os: OrderState;
  tabs: TabRow[];
  hub: { url: string; connected: boolean };
  cfg: { version: number; hash: string; meta: CfgMeta | null; pending?: number };
  proxy: { label: string } | null;
  egress: Egress | null;
  payQueue: { tabId: number; orderId: string }[];
  payActive: number | null;
  prepared: { ok: boolean; detail: string; at: number } | null;
  orders: OrderRecord[];
  validation: { errors: string[]; warnings: string[] };
  log: string[];
}

const $ = (id: string) => document.getElementById(id)!;

function send<T = any>(c: Cmd): Promise<T> {
  return chrome.runtime.sendMessage(c);
}

function el(tag: string, text?: string, cls?: string): HTMLElement {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function ago(ts?: number): string {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 60 ? `${s} с назад` : s < 3600 ? `${Math.floor(s / 60)} мин назад` : new Date(ts).toLocaleString();
}

function until(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const s = Math.round((t - Date.now()) / 1000);
  if (s <= 0) return `${new Date(t).toLocaleString()} (прошло)`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${new Date(t).toLocaleString()} · через ${h ? `${h} ч ` : ''}${m} мин ${s % 60} с`;
}

let lastLog = '';
let cur: Status | null = null;

function render(st: Status): void {
  cur = st;
  $('who').textContent = `профиль ${st.profileId || '— (нет имени)'} · сервер ${st.server || '—'} · заказ ${st.order?.id ?? '— (не назначен)'}`;
  const mode = $('mode');
  mode.textContent = st.mode;
  mode.className = `badge ${st.mode === 'assist' ? 'warn' : 'ok'}`;
  $('assist').textContent = st.mode === 'assist' ? 'Ассистент: выкл' : 'Ассистент: вкл';
  const hub = $('hub');
  hub.textContent = st.hub.url ? `хаб ${st.hub.connected ? '✓' : '✗'}` : 'без хаба';
  hub.title = st.hub.url;
  hub.className = `badge ${st.hub.url ? (st.hub.connected ? 'ok' : 'err') : ''}`;
  $('strategy').textContent = `Стратегия: ${st.strategy}${st.os.armed ? ' (сменится сразу)' : ''}`;

  const sum = $('summary');
  sum.textContent = '';
  const kv = (k: string, v: string, cls = '') => { sum.append(el('span', k, 'muted'), el('span', v, cls)); };
  const os = st.os;
  kv('сайт', st.mock ? `${st.baseUrl} — МОК, не Apple! (Настройки → baseUrl)` : st.baseUrl, st.mock ? 'warn' : '');
  kv('старт', `${until(st.openAt)}${st.autoStart ? ' · autoStart' : ''}`);
  kv('статус', os.armed ? (os.openedAt ? `OPEN ${ago(os.openedAt)} (${os.openSource ?? ''})` : 'взведён, ждём OPEN') : 'не запущен', os.openedAt ? 'ok' : '');
  if (os.fleetOpen && !os.openedAt) kv('флот', `${os.fleetOpen.profile} уже пустили ${ago(os.fleetOpen.at)} — ждём свой OPEN`, 'warn');
  if (st.order) {
    kv('цели', st.order.targets.join(', '));
    kv('магазины', `${st.order.stores.join(', ')} · оплата ${st.order.payment}`);
  }
  if (os.activeTarget) kv('активная цель', os.activeTarget);
  if (os.stage || os.inBagVerified) kv('заказ', `${os.stage ?? 'IN_BAG'}${os.winnerTabId ? ` · вкладка ${os.winnerTabId}` : ''}`);
  if (os.slotLabel) kv('слот', `${os.store ?? ''} · ${os.slotLabel}${os.billingReadyAt ? ` · выбран ${ago(os.billingReadyAt)}` : ''}`);
  if (os.orderNo) kv('номер', os.orderNo, 'ok');
  if (os.storeClosedSince) kv('Apple Store', `закрыт с ${new Date(os.storeClosedSince).toLocaleTimeString()} — вкладки обновляются, пока не пустит`, 'warn');
  else if (os.storeReopenedAt) kv('Apple Store', `открылся в ${new Date(os.storeReopenedAt).toLocaleTimeString()}`, 'ok');
  if (os.watch) {
    const w = Object.entries(os.watch).map(([p, s]) => `${p}: ${s.isBuyable ? 'BUYABLE' : s.reason ?? '?'}`).join(' · ');
    kv('наблюдатель', `${w}${os.watchAt ? ` · ${ago(os.watchAt)}` : ''}${os.watchSource === 'sw' ? ' · страховочный опрос из SW' : ''}`);
  }
  const eg = st.egress;
  const egText = !eg ? 'не проверялся' : eg.error ? `ошибка: ${eg.error} (${ago(eg.at)})` : `${eg.ip ?? '?'} · ${eg.country ?? '?'} · ${ago(eg.at)}`;
  kv('IP · страна', `${egText}${st.proxy ? ` · прокси ${st.proxy.label}` : ' · без прокси'}`, !eg ? 'warn' : eg.error || (eg.country && eg.country !== 'AE') ? 'err' : 'ok');
  const cm = st.cfg.meta;
  kv('конфиг', st.cfg.version ? `v${st.cfg.version}${cm ? ` · ${cm.source} · ${ago(cm.receivedAt)}` : ''}${st.cfg.pending ? ` · на хабе уже v${st.cfg.pending}, применится после Stop/Start` : ''}` : 'локальный (не с хаба)', st.cfg.pending ? 'warn' : '');
  kv('Prepare', st.prepared ? `${st.prepared.ok ? '✓' : '✗'} ${ago(st.prepared.at)} — ${st.prepared.detail}` : 'не выполнялся', st.prepared ? (st.prepared.ok ? 'ok' : 'err') : 'warn');
  if (st.payQueue.length || st.payActive) kv('оплата', `${st.payActive ? `сейчас вкладка ${st.payActive}` : '—'}${st.payQueue.length ? ` · ждут ${st.payQueue.map((p) => p.tabId).join(', ')}` : ''}`);

  const v = $('validation');
  v.textContent = '';
  if (st.validation.errors.length) v.append(el('div', `Ошибки конфига:\n• ${st.validation.errors.join('\n• ')}`, 'err'));
  if (st.validation.warnings.length) v.append(el('div', `• ${st.validation.warnings.join('\n• ')}`, 'warn'));

  const tb = $('tabs');
  tb.textContent = '';
  for (const t of st.tabs) {
    const tr = el('tr', undefined, 'click');
    tr.title = `${t.url ?? ''}\n${t.detail ?? ''}`;
    const stCls = /STUCK|TIMEOUT|ERROR/.test(t.state) ? 'err' : /ASSIST|HOLD|COUNTRY|BUSY|CLOSED|QUEUE|NEED_HUMAN/.test(t.state) ? 'warn' : /BILLING|PAY|ORDERED|IN_BAG/.test(t.state) ? 'ok' : '';
    tr.append(
      el('td', String(t.tabId) + (t.tabId === st.os.winnerTabId ? ' ★' : '')),
      el('td', t.role === 'idle' ? t.mode : t.role),
      el('td', t.state, stCls),
      el('td', t.detail ?? '', 'det'),
      el('td', `${t.outcome ?? ''}${t.atb404 ? ` · 404×${t.atb404}` : ''}`),
    );
    tr.onclick = () => void send({ cmd: 'focusTab', tabId: t.tabId });
    tb.append(tr);
  }
  if (!st.tabs.length) {
    const tr = el('tr');
    const td = el('td', 'нет вкладок apple.com/ae с расширением', 'muted');
    (td as HTMLTableCellElement).colSpan = 5;
    tr.append(td);
    tb.append(tr);
  }

  const ob = $('orders');
  ob.textContent = '';
  for (const r of [...st.orders].reverse()) {
    const tr = el('tr');
    tr.append(
      el('td', `${r.orderId}${r.profileId !== st.profileId ? ` (${r.profileId})` : ''}`),
      el('td', r.status === 'ORDERED' ? `✅ ${r.orderNo ?? ''}` : 'на оплате', r.status === 'ORDERED' ? 'ok' : 'warn'),
      el('td', `${r.partLabel} · ${r.storeName.replace(/^Apple /, '')} · ${r.slotLabel}`),
      el('td', `${r.firstName} ${r.lastName} · ${r.phone} · ${r.email}`),
      el('td', `${r.price ?? ''} ${r.payment}`),
    );
    ob.append(tr);
  }
  if (!st.orders.length) {
    const tr = el('tr');
    const td = el('td', 'пока нет заказов на оплате', 'muted');
    (td as HTMLTableCellElement).colSpan = 5;
    tr.append(td);
    ob.append(tr);
  }

  const log = st.log.join('\n');
  if (log !== lastLog) {
    const pre = $('log');
    const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
    pre.textContent = log;
    lastLog = log;
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  }
}

async function refresh(): Promise<void> {
  try {
    const st = await send<Status>({ cmd: 'status' });
    if (st?.ok) render(st);
  } catch (e) {
    $('result').textContent = `SW недоступен: ${e}`;
  }
}

function result(r: { ok?: boolean; error?: string; warnings?: string[] } | undefined, okText: string): void {
  const box = $('result');
  if (!r) { box.textContent = 'нет ответа'; box.className = 'msg err'; return; }
  box.className = `msg ${r.ok ? 'ok' : 'err'}`;
  box.textContent = r.ok ? `${okText}${r.warnings?.length ? `\n• ${r.warnings.join('\n• ')}` : ''}` : `Ошибка: ${r.error}`;
}

$('start').onclick = async () => result(await send({ cmd: 'start', source: 'popup' }), 'Запущено: вкладки открыты и взведены');
$('stop').onclick = async () => result(await send({ cmd: 'stop' }), 'Остановлено');
$('prepare').onclick = async () => result(await send({ cmd: 'prepare' }), 'Prepare: открыта вкладка прогрева');
$('clean').onclick = async () => result(await send({ cmd: 'cleanBag' }), 'Clean bag: открыта корзина');
$('strategy').onclick = async () => {
  const next: Strategy = cur?.strategy === 'hold' ? 'refresh' : 'hold';
  result(await send({ cmd: 'setStrategy', strategy: next }), `Стратегия: ${next}`);
  void refresh();
};
$('checkIp').onclick = async () => {
  const r = await send<{ ok: boolean; egress?: Egress; error?: string }>({ cmd: 'checkIp' });
  const e = r?.egress;
  result(r, e?.error ? `IP не проверен: ${e.error}` : `IP ${e?.ip ?? '?'} · ${e?.country ?? '?'}${e?.country && e.country !== 'AE' ? ' — НЕ ОАЭ!' : ''}`);
  void refresh();
};
$('fetchConfig').onclick = async () => {
  const r = await send<{ ok: boolean; version?: number; error?: string }>({ cmd: 'fetchConfig' });
  result(r, r?.version ? `Конфиг с хаба: v${r.version}` : 'Конфиг с хаба получен');
  void refresh();
};
$('assist').onclick = async () => result(await send({ cmd: 'toggleAssist' }), 'Режим переключён');
$('clearlog').onclick = async () => result(await send({ cmd: 'clearLog' }), 'Лог очищен');
$('options').onclick = () => void chrome.runtime.openOptionsPage();
function download(text: string, name: string, type: string): void {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
$('export').onclick = async () => {
  const r = await send<{ ok: boolean; text: string }>({ cmd: 'exportLog' });
  if (!r?.ok) return result(r, '');
  download(r.text, `apple-drop-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`, 'text/plain;charset=utf-8');
};
$('exportOrders').onclick = async () => {
  const r = await send<{ ok: boolean; text: string }>({ cmd: 'exportOrders' });
  if (!r?.ok) return result(r, '');
  download(r.text, `apple-drop-orders-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv;charset=utf-8');
  result(r, 'Заказы выгружены в CSV (открывается в Numbers/Excel)');
};

void refresh();
setInterval(() => void refresh(), 1000);
