// Минимальный клиент Chrome DevTools Protocol (BOT-SPEC §4, §9.2): настоящий клик, скриншот, снимок страницы,
// вывод вкладки вперёд. Порт отладки — только 127.0.0.1, свой на браузер.
import WebSocket from 'ws';

interface Pending { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

export class Cdp {
  private ws: WebSocket;
  private seq = 0;
  private pending = new Map<number, Pending>();
  closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data) => {
      let m: any;
      try { m = JSON.parse(String(data)); } catch { return; }
      if (m.id === undefined) return;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(`${m.error.message ?? 'CDP error'}`));
      else p.resolve(m.result);
    });
    ws.on('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('CDP закрыт')); }
      this.pending.clear();
    });
    ws.on('error', () => { /* close следом */ });
  }

  static async version(port: number, timeoutMs = 3000): Promise<{ Browser: string; webSocketDebuggerUrl: string } | null> {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
      return r.ok ? ((await r.json()) as { Browser: string; webSocketDebuggerUrl: string }) : null;
    } catch {
      return null;
    }
  }

  static async connect(port: number, timeoutMs = 5000): Promise<Cdp> {
    const v = await Cdp.version(port, timeoutMs);
    if (!v) throw new Error(`CDP :${port} не отвечает`);
    const ws = new WebSocket(v.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('CDP: таймаут подключения')), timeoutMs);
      ws.once('open', () => { clearTimeout(t); resolve(); });
      ws.once('error', (e) => { clearTimeout(t); reject(e); });
    });
    return new Cdp(ws);
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 10_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('CDP закрыт'));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method}: таймаут`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close(): void {
    this.closed = true;
    try { this.ws.close(); } catch { /* */ }
  }

  /** Вкладка страницы (по умолчанию — первая не служебная). */
  async pageTarget(match?: (url: string) => boolean): Promise<{ targetId: string; url: string } | null> {
    const { targetInfos } = await this.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>('Target.getTargets');
    const pages = targetInfos.filter((t) => t.type === 'page' && !t.url.startsWith('chrome-extension://') && !t.url.startsWith('devtools://'));
    const hit = (match ? pages.find((t) => match(t.url)) : undefined) ?? pages[0];
    return hit ? { targetId: hit.targetId, url: hit.url } : null;
  }

  async attach(targetId: string): Promise<string> {
    const { sessionId } = await this.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    return sessionId;
  }

  async detach(sessionId: string): Promise<void> {
    await this.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }

  /** Настоящий клик (Chrome считает его жестом пользователя): координаты — CSS-пиксели окна. */
  async click(sessionId: string, x: number, y: number): Promise<void> {
    const base = { x, y, button: 'left', clickCount: 1 };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base }, sessionId);
    await new Promise((r) => setTimeout(r, 40 + Math.random() * 60));
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base }, sessionId);
  }

  async screenshot(sessionId: string): Promise<Buffer> {
    const { data } = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'png' }, sessionId, 15_000);
    return Buffer.from(data, 'base64');
  }

  async bringToFront(sessionId: string): Promise<void> {
    await this.send('Page.bringToFront', {}, sessionId);
  }

  async evaluate<T = unknown>(sessionId: string, expression: string): Promise<T> {
    const r = await this.send<{ result: { value: T } }>('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
    return r.result.value;
  }

  async windowState(targetId: string, state: 'normal' | 'fullscreen' | 'maximized'): Promise<void> {
    const { windowId } = await this.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId });
    await this.send('Browser.setWindowBounds', { windowId, bounds: { windowState: state } });
  }
}

/** Разовое действие со страницей браузера: подключиться, найти вкладку, выполнить, отключиться. */
export async function withPage<T>(port: number, fn: (cdp: Cdp, sessionId: string, url: string) => Promise<T>, match?: (url: string) => boolean): Promise<T> {
  const cdp = await Cdp.connect(port);
  try {
    const t = await cdp.pageTarget(match);
    if (!t) throw new Error('нет вкладки страницы');
    const sid = await cdp.attach(t.targetId);
    try { return await fn(cdp, sid, t.url); } finally { await cdp.detach(sid); }
  } finally {
    cdp.close();
  }
}
