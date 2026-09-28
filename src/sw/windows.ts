// Вывод окна/вкладки вперёд (§7.7 FOCUS_FOR_PAY, §7.8).

export async function focusTab(tabId: number): Promise<boolean> {
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true, drawAttention: true });
    await chrome.tabs.update(tabId, { active: true });
    return true;
  } catch {
    return false;
  }
}
