// Режим бота (BOT-SPEC §4): лаунчер кладёт рядом с расширением bootstrap.json.
// Файл есть → режим бота (конфиг от хаба); нет → автономный режим, как раньше.

export interface Bootstrap { browserId: string; hubUrl: string; token: string; machine?: string }

export async function readBootstrap(): Promise<Bootstrap | null> {
  try {
    const r = await fetch(chrome.runtime.getURL('bootstrap.json'), { cache: 'no-store' });
    if (!r.ok) return null;
    const j = (await r.json()) as Partial<Bootstrap>;
    if (!j?.browserId || !j.hubUrl || !j.token) return null;
    return { browserId: String(j.browserId), hubUrl: String(j.hubUrl), token: String(j.token), machine: j.machine ? String(j.machine) : undefined };
  } catch {
    return null;
  }
}

/** Тяжёлые ресурсы страниц товара и корзины (§20.4): картинки, видео, шрифты с www.apple.com. Чекаут (secureN.store) не трогаем. */
export async function setHeavyBlocking(on: boolean): Promise<void> {
  const dnr = chrome.declarativeNetRequest;
  if (!dnr?.updateSessionRules) return;
  const ID = 9001;
  try {
    await dnr.updateSessionRules({
      removeRuleIds: [ID],
      addRules: on ? [{
        id: ID,
        priority: 1,
        action: { type: 'block' as chrome.declarativeNetRequest.RuleActionType },
        condition: {
          initiatorDomains: ['www.apple.com'],
          resourceTypes: ['image', 'media', 'font'] as chrome.declarativeNetRequest.ResourceType[],
        },
      }] : [],
    });
  } catch (e) {
    console.warn('DNR', e);
  }
}
