// Роли вкладок (§7.3): один наблюдатель на профиль (при хабе — один на всех), остальные — racer.
import type { Role } from '../shared/messages';
import type { Orchestrator, TabInfo } from './orchestrator';

export function computeRoles(o: Orchestrator): Map<number, Role> {
  const roles = new Map<number, Role>();
  const race = [...o.tabs.values()].filter((t) => t.mode === 'race' && t.state !== 'STUCK').sort((a, b) => a.tabId - b.tabId);
  const otherProfileWatches = o.hub.connected && o.watcherProfiles.length > 0 && !o.watcherProfiles.includes(o.cfg.profileId);
  const needWatcher = o.os.armed && !o.os.openedAt && !otherProfileWatches;
  let watcher: TabInfo | undefined;
  if (needWatcher) {
    // держим роль за той же вкладкой, пока она жива (наблюдатель не рефрешится до OPEN)
    watcher = race.find((t) => t.tabId === o.os.watcherTabId) ?? race.find((t) => t.port) ?? race[0];
  }
  for (const t of o.tabs.values()) {
    let r: Role = 'idle';
    if (t.mode === 'race') r = t === watcher ? 'watcher' : 'racer';
    else if (t.mode === 'standby') r = 'standby';
    roles.set(t.tabId, r);
  }
  o.os.watcherTabId = watcher?.tabId;
  return roles;
}

export function assignRoles(o: Orchestrator): void {
  const roles = computeRoles(o);
  for (const [tabId, role] of roles) {
    const t = o.tabs.get(tabId);
    if (!t || t.role === role) continue;
    t.role = role;
    o.sendTab(tabId, { t: 'ROLE', role }, false);
    if (role === 'watcher') {
      o.log(tabId, 'ROLE', 'наблюдатель (JSON fulfillment-messages)');
      // наблюдатель — активная вкладка своего окна: видимую вкладку Chrome не тормозит
      chrome.tabs.update(tabId, { active: true }).catch(() => {});
    }
  }
}
