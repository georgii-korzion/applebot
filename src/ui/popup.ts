// Popup (§7.9): статус профиля, вкладки, Start/Stop/Prepare/Clean bag/Следующий/Ассистент/Экспорт лога.
import type { Cmd, OrderState, TabRow } from '../shared/messages';

interface Status {
  ok: boolean;
  profileId: string;
  mode: 'auto' | 'assist';
  openAt: string;
  order: { id: string; targets: string[]; stores: string[]; payment: string; racers: number } | null;
  os: OrderState;
  tabs: TabRow[];
  hub: { url: string; connected: boolean; watcher: string | null };
  payQueue: { tabId: number; orderId: string }[];
  payActive: number | null;
  prepared: { ok: boolean; detail: string; at: number } | null;
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

function render(st: Status): void {
  $('who').textContent = `профиль ${st.profileId} · заказ ${st.order?.id ?? '— (не назначен)'}`;
  const mode = $('mode');
  mode.textContent = st.mode;
  mode.className = `badge ${st.mode === 'assist' ? 'warn' : 'ok'}`;
  $('assist').textContent = st.mode === 'assist' ? 'Ассистент: выкл' : 'Ассистент: вкл';
  const hub = $('hub');
  hub.textContent = st.hub.url ? `hub ${st.hub.connected ? '●' : '○'}${st.hub.watcher ? ` · watcher ${st.hub.watcher}` : ''}` : 'без хаба';
  hub.className = `badge ${st.hub.url ? (st.hub.connected ? 'ok' : 'err') : ''}`;

  const sum = $('summary');
  sum.textContent = '';
  const kv = (k: string, v: string, cls = '') => { sum.append(el('span', k, 'muted'), el('span', v, cls)); };
  const os = st.os;
  kv('старт', until(st.openAt));
  kv('статус', os.armed ? (os.openedAt ? `OPEN ${ago(os.openedAt)} (${os.openSource ?? ''})` : 'взведён, ждём OPEN') : 'не запущен', os.openedAt ? 'ok' : '');
  if (st.order) {
    kv('цели', st.order.targets.join(', '));
    kv('магазины', `${st.order.stores.join(', ')} · оплата ${st.order.payment}`);
  }
  if (os.activeTarget) kv('активная цель', os.activeTarget);
  if (os.stage || os.inBagVerified) kv('заказ', `${os.stage ?? 'IN_BAG'}${os.decision ? ` · ${os.decision}` : ''}${os.winnerTabId ? ` · вкладка ${os.winnerTabId}` : ''}`);
  if (os.slotLabel) kv('слот', `${os.store ?? ''} · ${os.slotLabel}${os.billingReadyAt ? ` · выбран ${ago(os.billingReadyAt)}` : ''}`);
  if (os.orderNo) kv('номер', os.orderNo, 'ok');
  if (os.storeClosedSince) kv('Apple Store', `закрыт с ${new Date(os.storeClosedSince).toLocaleTimeString()} — вкладки обновляются, пока не пустит`, 'warn');
  else if (os.storeReopenedAt) kv('Apple Store', `открылся в ${new Date(os.storeReopenedAt).toLocaleTimeString()}`, 'ok');
  if (os.watch) {
    const w = Object.entries(os.watch).map(([p, s]) => `${p}: ${s.isBuyable ? 'BUYABLE' : s.reason ?? '?'}`).join(' · ');
    kv('наблюдатель', `${w}${os.watchAt ? ` · ${ago(os.watchAt)}` : ''}${os.watchSource === 'sw' ? ' · страховочный опрос из SW' : ''}`);
  }
  kv('Prepare', st.prepared ? `${st.prepared.ok ? '✓' : '✗'} ${ago(st.prepared.at)} — ${st.prepared.detail}` : 'не выполнялся', st.prepared ? (st.prepared.ok ? 'ok' : 'err') : 'warn');
  if (st.payQueue.length || st.payActive) kv('очередь оплаты', `${st.payActive ? `сейчас вкладка ${st.payActive}` : '—'}${st.payQueue.length ? ` · ждут ${st.payQueue.map((p) => p.tabId).join(', ')}` : ''}`);

  const v = $('validation');
  v.textContent = '';
  if (st.validation.errors.length) v.append(el('div', `Ошибки конфига:\n• ${st.validation.errors.join('\n• ')}`, 'err'));
  if (st.validation.warnings.length) v.append(el('div', `• ${st.validation.warnings.join('\n• ')}`, 'warn'));

  const tb = $('tabs');
  tb.textContent = '';
  for (const t of st.tabs) {
    const tr = el('tr', undefined, 'click');
    tr.title = `${t.url ?? ''}\n${t.detail ?? ''}`;
    const stCls = /STUCK|TIMEOUT|ERROR/.test(t.state) ? 'err' : /ASSIST|STANDBY|COUNTRY|BUSY|CLOSED|QUEUE|NEED_HUMAN/.test(t.state) ? 'warn' : /BILLING|PAY|ORDERED|IN_BAG/.test(t.state) ? 'ok' : '';
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

$('start').onclick = async () => result(await send({ cmd: 'start' }), 'Запущено: вкладки открыты и взведены');
$('stop').onclick = async () => result(await send({ cmd: 'stop' }), 'Остановлено');
$('prepare').onclick = async () => result(await send({ cmd: 'prepare' }), 'Prepare: открыта вкладка прогрева');
$('clean').onclick = async () => result(await send({ cmd: 'cleanBag' }), 'Clean bag: открыта корзина');
$('next').onclick = async () => result(await send({ cmd: 'nextPay' }), 'Следующий на оплату');
$('assist').onclick = async () => result(await send({ cmd: 'toggleAssist' }), 'Режим переключён');
$('clearlog').onclick = async () => result(await send({ cmd: 'clearLog' }), 'Лог очищен');
$('options').onclick = () => void chrome.runtime.openOptionsPage();
$('export').onclick = async () => {
  const r = await send<{ ok: boolean; text: string }>({ cmd: 'exportLog' });
  if (!r?.ok) return result(r, '');
  const blob = new Blob([r.text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `apple-drop-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

void refresh();
setInterval(() => void refresh(), 1000);
