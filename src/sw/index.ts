// Вход service worker. Все слушатели регистрируются синхронно на верхнем уровне (MV3).
import { K } from '../shared/config';
import type { Cmd } from '../shared/messages';
import { Orchestrator } from './orchestrator';
import { initDiag } from './diag';
import { initNotifyClicks } from './notify';
import { initProxyAuth } from './proxy';

// content scripts пишут своё состояние в storage.session напрямую (надёжно перед навигацией)
void chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' as chrome.storage.AccessLevel });

const orch = new Orchestrator();

chrome.runtime.onConnect.addListener((port) => orch.onConnect(port));

chrome.runtime.onMessage.addListener((msg: Cmd & { target?: string }, _sender, reply) => {
  if (msg?.target === 'offscreen' || !msg?.cmd) return false;
  orch.onCommand(msg).then(reply, (e) => reply({ ok: false, error: String(e) }));
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (K.config in changes || K.profileId in changes || K.hubUrl in changes || K.modeOverride in changes) void orch.ready.then(() => orch.reloadSoon());
});

chrome.tabs.onRemoved.addListener((tabId) => { void orch.ready.then(() => orch.onTabRemoved(tabId)); });
// 'complete' приходит на каждую загрузку, даже если редирект вернул тот же адрес заглушки (url-события тогда нет)
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url || info.status === 'complete') void orch.ready.then(() => orch.onTabUpdated(tabId, info.url ?? tab.url, info.status === 'complete'));
});

// логин/пароль прокси профиля (FLEET-SPEC §7): слушатель регистрируется синхронно, учётные данные — из конфига
initProxyAuth(() => orch.ready.then(() => orch.proxyCreds()), (msg, level) => { void orch.ready.then(() => orch.log('sw', 'PROXY', msg, level)); });

initDiag((tabId, acpartNone, at) => orch.sendTab(tabId, { t: 'NET', kind: 'updateSummary', acpartNone, at }, false));
initNotifyClicks();

// сброс буфера логов, STATUS хабу и проверка «ушедших» вкладок раз в 30 с (SW может быть выгружен между событиями)
chrome.alarms.create('tick', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  void orch.ready.then(() => { orch.ensureSwWatch(); orch.pulse(); return Promise.all([orch.logs.flush(), orch.checkAway()]); });
});

chrome.runtime.onInstalled.addListener(async (d) => {
  if (d.reason !== 'install') return;
  const s = await chrome.storage.local.get(K.config);
  if (!s[K.config]) void chrome.runtime.openOptionsPage();
});
