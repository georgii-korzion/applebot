// Роли вкладок (§7.3, FLEET-SPEC §3): один наблюдатель JSON на профиль, остальные — racer. Хаб на роли не влияет.
import type { Role } from '../shared/messages';
import type { Orchestrator, TabInfo } from './orchestrator';

export function computeRoles(o: Orchestrator): Map<number, Role> {
  const roles = new Map<number, Role>();
  const race = [...o.tabs.values()].filter((t) => t.mode === 'race' && t.state !== 'STUCK').sort((a, b) => a.tabId - b.tabId);
  const needWatcher = o.os.armed && !o.os.openedAt;
  let watcher: TabInfo | undefined;
  if (needWatcher) {
    // держим роль за той же вкладкой, пока она жива (наблюдатель не рефрешится до OPEN, если он не один)
    watcher = race.find((t) => t.tabId === o.os.watcherTabId) ?? race.find((t) => t.port) ?? race[0];
  }
  for (const t of o.tabs.values()) {
    roles.set(t.tabId, t.mode === 'race' ? (t === watcher ? 'watcher' : 'racer') : 'idle');
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
