// Настоящий клик по кнопке Apple Pay через chrome.debugger (FLEET-SPEC §8).
// Единственное место, где используется debugger: один attach на попытку, три Input.dispatchMouseEvent, всегда detach.
// Никаких других команд CDP. Лист Apple Pay / QR Chrome открывает только на доверенное событие — программный клик
// из content script он отвергает (правило браузера, не защита Apple).

export interface Point { x: number; y: number }
export interface ClickResult { ok: boolean; error?: string }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function debuggerClick(tabId: number, first: Point, recheck: () => Promise<Point | null>): Promise<ClickResult> {
  if (!chrome.debugger?.attach) return { ok: false, error: 'chrome.debugger недоступен (нет права debugger в manifest?)' };
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (e) {
    return { ok: false, error: `attach: ${errText(e)}` };
  }
  try {
    // полоска «расширение управляет браузером» могла сдвинуть страницу — координаты запрашиваем ещё раз
    await sleep(300);
    const p = (await recheck()) ?? first;
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `dispatchMouseEvent: ${errText(e)}` };
  } finally {
    setTimeout(() => { void chrome.debugger.detach(target).catch(() => {}); }, 1500);
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
