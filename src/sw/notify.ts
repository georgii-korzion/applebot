// Уведомления + звук через offscreen-документ (§7.7, §7.8).
import type { SoundKind } from '../shared/messages';
import { focusTab } from './windows';

const tabByNotif = new Map<string, number>();

export async function notify(o: { id?: string; title: string; message: string; tabId?: number; sound?: SoundKind; sticky?: boolean }): Promise<void> {
  const id = o.id ?? `n-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  try {
    if (o.id) await chrome.notifications.clear(id);
    await chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: o.title,
      message: o.message || ' ',
      priority: 2,
      requireInteraction: !!o.sticky,
    });
  } catch (e) {
    console.warn('notification failed', e);
  }
  if (o.tabId !== undefined) tabByNotif.set(id, o.tabId);
  if (o.sound) void playSound(o.sound);
}

export function initNotifyClicks(): void {
  chrome.notifications.onClicked.addListener((id) => {
    const tabId = tabByNotif.get(id);
    if (tabId !== undefined) void focusTab(tabId);
    void chrome.notifications.clear(id);
  });
}

let creating: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType] });
  if (ctx.length) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK' as chrome.offscreen.Reason],
      justification: 'Звуковой сигнал: открытие продаж, заказ готов к оплате, нужен клик человека',
    }).catch((e) => console.warn('offscreen', e)).finally(() => { creating = null; });
  }
  await creating;
}

export async function playSound(kind: SoundKind): Promise<void> {
  try {
    await ensureOffscreen();
    await chrome.runtime.sendMessage({ target: 'offscreen', t: 'PLAY', kind });
  } catch (e) {
    console.warn('sound failed', e);
  }
}
