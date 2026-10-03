// Режим бота в service worker (BOT-SPEC §3, §6, §13, §14): конфиг и заказ от хаба, пульс STATE,
// пересылка сообщений оплаты/человека/снимков, возврат в пул. Автономный режим этот файл не трогает.
import { IS_DEV_BUILD, LIVE_BASE, defaultOrder, normalizeConfig, type Config, type OrderCfg } from '../shared/config';
import { defaultBotRuntime } from '../shared/bot';
import { newOrderState, newTabState, type C2S, type Hub2S } from '../shared/messages';
import { partLabel, partUrl } from '../shared/parts';
import type { Orchestrator, TabInfo } from './orchestrator';
import { readBootstrap, setHeavyBlocking } from './bootstrap';
import { lastDocHeaders } from './diag';
import { notify, playSound, setQuiet } from './notify';
import { focusTab } from './windows';
import { assignRoles } from './watcher';

const K_CFG = 'botCfg';
const K_ORDER = 'botOrder';

/** id назначенного заказа или null (пул). */
export function assignedId(o: Orchestrator): string | null {
  return o.order && !o.order.lobby && o.order.id ? o.order.id : null;
}

export function lobbyOrder(cfg: Config): OrderCfg {
  const d = defaultOrder('');
  const b = cfg.bot ?? defaultBotRuntime(cfg.profileId);
  return {
    ...d, id: '', lobby: true, priority: 99, profiles: [cfg.profileId], racersPerProfile: 1,
    targets: b.lobby.targets.length ? b.lobby.targets : d.targets,
    stores: b.lobby.stores.length ? b.lobby.stores : d.stores,
    contact: { firstName: '', lastName: '', email: '', phone: '' },
  };
}

function baseCfg(o: Orchestrator): Config {
  const b = o.bot!;
  const cfg = normalizeConfig({ profileId: b.browserId, hubUrl: b.hubUrl, orders: [] });
  cfg.orders = [];
  cfg.limits.maxTabsTotal = 1;
  cfg.bot = { ...defaultBotRuntime(b.browserId), machine: b.machine ?? '' };
  return cfg;
}

/** Старт SW в режиме бота: конфиг/заказ из chrome.storage.session (пережили выгрузку SW) или пустые до CONFIG. */
export async function botInit(o: Orchestrator): Promise<boolean> {
  o.bot = await readBootstrap();
  if (!o.bot) return false;
  setQuiet(true);
  const s = await chrome.storage.session.get([K_CFG, K_ORDER]);
  o.cfg = s[K_CFG] ? normalizeConfig(s[K_CFG]) : baseCfg(o);
  o.cfg.profileId = o.bot.browserId;
  o.cfg.hubUrl = o.bot.hubUrl;
  o.cfg.bot ??= defaultBotRuntime(o.bot.browserId);
  const saved = s[K_ORDER] ? normalizeConfig({ orders: [s[K_ORDER]] }).orders[0] : null;
  o.order = saved && !saved.lobby ? saved : lobbyOrder(o.cfg);
  o.cfg.orders = [o.order];
  void setHeavyBlocking(!!o.cfg.bot.blockHeavy);
  return true;
}

export function mainTab(o: Orchestrator): TabInfo | undefined {
  const w = o.os.winnerTabId !== undefined ? o.tabs.get(o.os.winnerTabId) : undefined;
  if (w) return w;
  for (const id of o.os.raceTabs) { const t = o.tabs.get(id); if (t) return t; }
  const all = [...o.tabs.values()];
  return all.filter((t) => t.mode !== 'idle').sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? all.sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

function pathOf(url: string): string {
  try { return new URL(url).pathname; } catch { return ''; }
}

/** STATE в хаб: на каждый переход (beat=false) и пульс раз в 2 с (§11). */
export function sendState(o: Orchestrator, t: TabInfo, beat: boolean): void {
  if (!o.bot || !o.hub.connected) return;
  o.hub.send({
    t: 'STATE', profile: o.cfg.profileId, orderId: assignedId(o), state: t.state, since: t.since ?? t.updatedAt, mode: t.mode,
    detail: t.detail, page: t.page, step: t.step, path: pathOf(t.url), error: t.lastError, reloads: t.reloads, perf: beat ? undefined : t.perf, beat, manual: t.manual,
  });
}

export function startHeartbeat(o: Orchestrator): void {
  setInterval(() => {
    const t = mainTab(o);
    if (t) sendState(o, t, true);
  }, 2000);
}

// ---------- CONFIG / ASSIGN / пул ----------
export async function applyConfig(o: Orchestrator, raw: Config): Promise<void> {
  const cfg = normalizeConfig(raw);
  const b = o.bot!;
  cfg.profileId = b.browserId;
  cfg.hubUrl = b.hubUrl;
  cfg.bot ??= defaultBotRuntime(b.browserId);
  if (!IS_DEV_BUILD && cfg.baseUrl !== LIVE_BASE) {
    o.log('sw', 'CONFIG', `хаб прислал baseUrl ${cfg.baseUrl} — боевая сборка работает только с ${LIVE_BASE}; конфиг не принят`, 'error');
    return;
  }
  const prevStrategy = o.cfg?.bot?.strategy;
  o.cfg = cfg;
  if (!o.order || o.order.lobby) o.order = lobbyOrder(cfg);
  cfg.orders = [o.order];
  await chrome.storage.session.set({ [K_CFG]: cfg });
  void setHeavyBlocking(cfg.bot!.blockHeavy);
  o.log('sw', 'CONFIG', `конфиг от хаба: openAt ${cfg.openAt}, стратегия ${cfg.bot!.strategy}${prevStrategy && prevStrategy !== cfg.bot!.strategy ? ` (была ${prevStrategy})` : ''}, ${cfg.bot!.stopBeforePay ? 'стоп перед оплатой' : 'оплата до конца'}`);
  o.broadcast({ t: 'CONFIG', cfg, order: o.order }, (t) => !!t.port);
  scheduleSnapshots(o);
  o.ensureSwWatch();
  if (!o.os.armed && cfg.bot!.autoStart) await startBot(o);
}

export async function assign(o: Orchestrator, raw: OrderCfg): Promise<void> {
  const ord = normalizeConfig({ orders: [raw] }).orders[0];
  ord.profiles = [o.cfg.profileId];
  ord.racersPerProfile = 1;
  const same = assignedId(o) === ord.id;
  o.order = ord;
  o.cfg.orders = [ord];
  await chrome.storage.session.set({ [K_ORDER]: ord });
  if (!same) {
    const buy = Object.entries(o.os.watch ?? {}).filter(([, s]) => s.isBuyable).map(([p]) => p);
    const target = ord.targets.find((p) => buy.includes(p)) ?? ord.targets[0];
    const k = o.os;
    o.os = {
      ...newOrderState(), armed: true, startedAt: k.startedAt ?? Date.now(), openedAt: k.openedAt, openSource: k.openSource,
      watch: k.watch, watchAt: k.watchAt, watchSource: k.watchSource, watchTargets: k.watchTargets, raceTabs: k.raceTabs,
      watcherTabId: k.watcherTabId, activeTarget: target, storeClosedSince: k.storeClosedSince, storeReopenedAt: k.storeReopenedAt,
      admittedAt: k.admittedAt, timestamps: { ...k.timestamps, assigned: Date.now() },
    };
    const pay = ord.payment === 'manual' ? `карта ****${ord.card.number.slice(-4)}` : 'Apple Pay';
    o.log('sw', 'ASSIGN', `заказ ${ord.id}: ${partLabel(target)} · ${ord.stores.join(',')} · ${pay}`);
  } else o.log('sw', 'ASSIGN', `заказ ${ord.id} обновлён${ord.payment === 'manual' ? ` (карта ****${ord.card.number.slice(-4)})` : ' (Apple Pay)'}`);
  await o.saveOs(true);
  o.broadcast({ t: 'CONFIG', cfg: o.cfg, order: ord }, (t) => !!t.port);
}

/** Запас почистил корзину (или заказ снят) — браузер снова в пуле: страница цели → ADMITTED → следующий заказ (§6.5). */
export async function release(o: Orchestrator, tabId: number | undefined, reason: string): Promise<void> {
  const oid = assignedId(o);
  o.order = lobbyOrder(o.cfg);
  o.cfg.orders = [o.order];
  await chrome.storage.session.remove(K_ORDER);
  const k = o.os;
  o.os = {
    ...newOrderState(), armed: k.armed, startedAt: k.startedAt, openedAt: k.openedAt, openSource: k.openSource, watch: k.watch, watchAt: k.watchAt,
    watchTargets: k.watchTargets, raceTabs: k.raceTabs, activeTarget: o.order.targets[0], timestamps: { ...k.timestamps, released: Date.now() },
  };
  await o.saveOs(true);
  o.broadcast({ t: 'CONFIG', cfg: o.cfg, order: o.order }, (t) => !!t.port);
  o.log('sw', 'RELEASED', `${oid ? `заказ ${oid} отпущен` : 'без заказа'} (${reason}) — назад в пул`);
  if (oid) o.hub.send({ t: 'RELEASED', profile: o.cfg.profileId, orderId: oid, reason });
  if (tabId !== undefined && o.os.armed) {
    o.sendTab(tabId, { t: 'MODE', mode: 'race', reset: true, extra: { target: o.os.activeTarget } });
  }
}

/** Старт гонки бота: рабочая вкладка — та, что открыл лаунчер (одна вкладка на браузер, §3.1). */
export async function startBot(o: Orchestrator): Promise<void> {
  if (o.os.armed) return;
  const target = o.order?.targets[0];
  if (!target) return;
  const keep = o.os;
  o.os = { ...newOrderState(), armed: true, startedAt: Date.now(), activeTarget: target, watchTargets: keep.watchTargets, openedAt: keep.openedAt, openSource: keep.openSource };
  const url = partUrl(o.cfg.baseUrl, target);
  const tabs = await chrome.tabs.query({});
  const ours = (u?: string) => !!u && (u.startsWith(o.cfg.baseUrl) || /^https:\/\/[^/]*apple\.com\//.test(u));
  let tab = tabs.find((t) => ours(t.url)) ?? tabs.find((t) => t.id !== undefined && !/^chrome-extension:/.test(t.url ?? ''));
  if (!tab?.id) {
    tab = await chrome.tabs.create({ url, active: true });
    if (tab.id === undefined) return;
    await o.initTab(tab.id, newTabState('race', { target, lastTargetNavAt: Date.now() }));
  } else {
    await o.initTab(tab.id, newTabState('race', { target, lastTargetNavAt: Date.now() }));
    await chrome.tabs.update(tab.id, { url, active: true });
  }
  o.os.raceTabs = [tab.id!];
  o.keepTab(tab.id!);
  await o.saveOs(true);
  o.ensureSwWatch();
  o.log('sw', 'START', `бот: браузер ${o.cfg.profileId}, стратегия ${o.cfg.bot?.strategy}, цель ${partLabel(target)}, openAt ${o.cfg.openAt}`);
  o.register();
  assignRoles(o);
}

// ---------- снимки заглушки T−60, T+0, T+30 (§7) ----------
let snapTimers: ReturnType<typeof setTimeout>[] = [];
function scheduleSnapshots(o: Orchestrator): void {
  for (const t of snapTimers) clearTimeout(t);
  snapTimers = [];
  if (!o.cfg.bot?.snapshots) return;
  const openAt = Date.parse(o.cfg.openAt);
  if (!Number.isFinite(openAt)) return;
  for (const [dt, reason] of [[-60_000, 'T-60'], [0, 'T+0'], [30_000, 'T+30']] as const) {
    const ms = openAt + dt - Date.now();
    if (ms <= 0 || ms > 6 * 3600_000) continue;
    snapTimers.push(setTimeout(() => {
      const t = mainTab(o);
      if (t) o.sendTab(t.tabId, { t: 'SNAP_REQ', reason }, false);
    }, ms));
  }
}

// ---------- окно на весь экран для QR Apple Pay ----------
const prevWindowState = new Map<number, string>();
export async function setFullscreen(windowId: number, on: boolean): Promise<void> {
  try {
    if (on) {
      const w = await chrome.windows.get(windowId);
      if (w.state !== 'fullscreen') prevWindowState.set(windowId, w.state ?? 'normal');
      await chrome.windows.update(windowId, { state: 'fullscreen', focused: true });
    } else if (prevWindowState.has(windowId)) {
      const st = prevWindowState.get(windowId)!;
      prevWindowState.delete(windowId);
      await chrome.windows.update(windowId, { state: (st === 'fullscreen' ? 'normal' : st) as chrome.windows.WindowState });
    }
  } catch { /* окно закрыто */ }
}

// ---------- сообщения вкладки (режим бота) ----------
export function onBotTabMsg(o: Orchestrator, tabId: number, t: TabInfo, m: C2S): boolean {
  const me = o.cfg.profileId;
  const oid = assignedId(o);
  switch (m.t) {
    case 'ADMITTED':
      o.os.admittedAt ??= m.at;
      o.os.spare = false;
      void o.saveOs();
      o.log(tabId, 'ADMITTED', `пустили к покупке${o.os.openedAt ? ` (+${((m.at - o.os.openedAt) / 1000).toFixed(1)} с от OPEN)` : ''}${oid ? '' : ' — жду заказ от хаба'}`);
      o.hub.send({ t: 'ADMITTED', profile: me, at: m.at, part: m.part, reloads: t.reloads });
      return true;
    case 'PLACE_REQ':
      if (o.bot && o.hub.connected && oid) o.hub.send({ t: 'PLACE_REQ', profile: me, orderId: oid });
      else {
        if (o.bot) o.log(tabId, 'PLACE', 'хаба нет — Place Order без очереди по карте');
        o.sendTab(tabId, { t: 'PLACE_TURN', local: true }, false);
      }
      return true;
    case 'PLACED':
      o.os.placedAt = m.at;
      o.os.timestamps.placed = m.at;
      void o.saveOs();
      if (oid) o.hub.send({ t: 'PLACED', profile: me, orderId: oid, at: m.at });
      return true;
    case 'PAY_WAIT':
      o.os.payWait = m.kind === '3ds' ? 'WAIT_3DS' : 'WAIT_APPLEPAY';
      void o.saveOs();
      if (oid) o.hub.send({ t: 'PAY_WAIT', profile: me, orderId: oid, kind: m.kind, input: m.input, detail: m.detail });
      if (m.kind === 'applepay_qr') {
        if (o.cfg.bot?.applePay.fullscreen) void setFullscreen(t.windowId, true);
        void focusTab(tabId);
        void notify({ id: `qr-${tabId}`, title: `Заказ ${oid}: сканируй QR Apple Pay`, message: 'Окно с кодом на весь экран', tabId, sound: 'pay', sticky: true });
      } else void notify({ id: `3ds-${tabId}`, title: `Заказ ${oid}: подтверди оплату в банке`, message: m.input ? 'Банк просит ввод на странице — окно впереди' : 'Подтверждение в приложении банка', tabId, sound: 'pay', sticky: true });
      if (m.input) void focusTab(tabId);
      return true;
    case 'CARD_DECLINED':
      o.log(tabId, 'CARD_DECLINED', `отказ карты: ${m.text}`, 'warn');
      if (oid && o.hub.connected) o.hub.send({ t: 'CARD_DECLINED', profile: me, orderId: oid, text: m.text });
      else o.sendTab(tabId, { t: 'SWITCH_PAY', method: 'applepay' }, false); // без хаба: этот браузер — на Apple Pay сам
      return true;
    case 'CARD_SWAP_ACK':
      if (oid) o.hub.send({ t: 'CARD_SWAP_ACK', profile: me, orderId: oid, cardId: o.order?.cardId, ok: m.ok, detail: m.detail });
      return true;
    case 'CARD_REQ':
      if (oid && o.hub.connected) o.hub.send({ t: 'CARD_REQ', profile: me, orderId: oid });
      return true;
    case 'NEED_HUMAN':
      o.log(tabId, 'NEED_HUMAN', `${m.reason} · ${m.step}: ${m.text}`, 'warn');
      o.hub.send({ t: 'NEED_HUMAN', profile: me, orderId: oid, reason: m.reason, step: m.step, text: m.text });
      if (!o.hub.connected) { void focusTab(tabId); void playSound('assist'); }
      return true;
    case 'HUMAN_DONE':
      o.hub.send({ t: 'HUMAN_DONE', profile: me });
      return true;
    case 'HUMAN':
      o.log(tabId, 'HUMAN', `кнопка на плашке: ${m.action}`);
      o.hub.send({ t: 'HUMAN', profile: me, action: m.action });
      if (m.action === 'stop') { o.os.armed = false; void o.saveOs(); }
      return true;
    case 'CLICK_REQ':
      if (o.hub.connected) o.hub.send({ t: 'CLICK_REQ', profile: me, purpose: m.purpose, how: m.how, target: m.target });
      else o.sendTab(tabId, { t: 'CLICK_DONE', ok: false, how: m.how, error: 'хаб недоступен' }, false);
      return true;
    case 'SNAPSHOT':
      o.hub.send({ t: 'SNAPSHOT', profile: me, reason: m.reason, cls: m.cls, url: pathOf(t.url), title: m.title, html: m.html, status: m.status, metaRefresh: m.metaRefresh, headers: lastDocHeaders(tabId) });
      return true;
    case 'BLOCKED':
      o.log(tabId, 'BLOCKED', `доступ закрыт (${m.status}): ${m.text}`, 'warn');
      o.hub.send({ t: 'BLOCKED', profile: me, status: m.status, text: m.text });
      return true;
    case 'FULLSCREEN':
      void setFullscreen(t.windowId, m.on);
      return true;
    default:
      return false;
  }
}

// ---------- сообщения хаба (режим бота) ----------
export function onBotHub(o: Orchestrator, m: Hub2S): boolean {
  const main = () => mainTab(o);
  switch (m.t) {
    case 'CONFIG':
      void applyConfig(o, m.cfg);
      return true;
    case 'ASSIGN':
      void assign(o, m.order);
      return true;
    case 'SPARE': {
      o.os.spare = true;
      void o.saveOs();
      o.log('sw', 'SPARE', 'заказов не хватило — запас: стою на странице товара, в корзину не кладу');
      const t = main();
      if (t) o.sendTab(t.tabId, { t: 'SPARE' });
      return true;
    }
    case 'UNASSIGN': {
      if (m.orderId !== assignedId(o)) return true;
      o.log('sw', 'UNASSIGN', `заказ ${m.orderId} снят: ${m.reason}`, 'warn');
      const t = main();
      if (o.os.placedAt) { o.log('sw', 'UNASSIGN', 'Place Order уже нажат — заказ не отдаю, жду человека', 'warn'); return true; }
      if (t && (t.mode === 'checkout' || t.mode === 'standby' || o.os.inBag)) {
        // корзину почистить, потом назад в пул (CLEANED → release)
        o.sendTab(t.tabId, { t: 'MODE', mode: 'clean' });
      } else void release(o, t?.tabId, m.reason);
      return true;
    }
    case 'SET_STRATEGY':
      if (o.cfg.bot && o.cfg.bot.strategy !== m.strategy) {
        o.cfg.bot.strategy = m.strategy;
        void chrome.storage.session.set({ [K_CFG]: o.cfg });
        o.log('sw', 'STRATEGY', `стратегия → ${m.strategy}${m.reason ? ` (${m.reason})` : ''}`);
        o.broadcast({ t: 'CONFIG', cfg: o.cfg, order: o.order }, (x) => !!x.port);
      }
      return true;
    case 'PLACE_TURN': {
      if (m.orderId !== assignedId(o)) return true;
      const t = main();
      if (t) o.sendTab(t.tabId, { t: 'PLACE_TURN' });
      return true;
    }
    case 'CARD_SWAP': {
      if (m.orderId !== assignedId(o) || !o.order) return true;
      o.order = { ...o.order, card: m.card, cardId: m.cardId, billing: m.billing, payment: 'manual' };
      o.cfg.orders = [o.order];
      void chrome.storage.session.set({ [K_ORDER]: o.order });
      o.log('sw', 'CARD_SWAP', `карта заменена → ****${m.card.number.slice(-4)}`);
      o.broadcast({ t: 'CONFIG', cfg: o.cfg, order: o.order }, (x) => !!x.port);
      const t = main();
      if (t) o.sendTab(t.tabId, { t: 'CARD_SWAP', card: m.card, cardId: m.cardId, billing: m.billing });
      return true;
    }
    case 'SWITCH_PAY': {
      if (m.orderId !== assignedId(o) || !o.order) return true;
      o.order = { ...o.order, payment: 'applepay' };
      o.cfg.orders = [o.order];
      void chrome.storage.session.set({ [K_ORDER]: o.order });
      o.log('sw', 'SWITCH_PAY', 'оплата → Apple Pay');
      o.broadcast({ t: 'CONFIG', cfg: o.cfg, order: o.order }, (x) => !!x.port);
      const t = main();
      if (t) o.sendTab(t.tabId, { t: 'SWITCH_PAY', method: 'applepay' });
      return true;
    }
    case 'COMMAND': {
      const t = main();
      switch (m.cmd) {
        case 'focus':
          if (t) { void focusTab(t.tabId); if (m.arg === 'fullscreen') void setFullscreen(t.windowId, true); }
          void playSound('assist');
          break;
        case 'unfocus':
          if (t) void setFullscreen(t.windowId, false);
          break;
        case 'stop':
          void o.onCommand({ cmd: 'stop' });
          break;
        case 'prepare':
          void o.onCommand({ cmd: 'prepare' });
          break;
        case 'clean':
          void o.onCommand({ cmd: 'cleanBag' });
          break;
        default:
          if (t) o.sendTab(t.tabId, { t: 'CMD', cmd: m.cmd });
      }
      return true;
    }
    case 'CLICK_DONE': {
      const t = main();
      if (t) o.sendTab(t.tabId, { t: 'CLICK_DONE', ok: m.ok, how: m.how, error: m.error }, false);
      return true;
    }
    case 'REJECT':
      o.log('sw', 'HUB', `хаб отклонил подключение: ${m.reason}`, 'error');
      return true;
    default:
      return false;
  }
}
