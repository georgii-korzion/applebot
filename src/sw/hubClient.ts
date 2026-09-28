// WebSocket к локальному хабу (необязательно, §5.1): реконнект, ping каждые 20 с.
import type { Hub2S, S2Hub } from '../shared/messages';

export class HubClient {
  private ws: WebSocket | null = null;
  private url = '';
  private retryMs = 1000;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  connected = false;

  constructor(
    private onMsg: (m: Hub2S) => void,
    private onState: (connected: boolean) => void,
  ) {}

  get address(): string { return this.url; }

  setUrl(url: string): void {
    if (url === this.url) {
      if (url && !this.ws && !this.retryTimer) this.connect();
      return;
    }
    this.url = url;
    this.close();
    if (url) this.connect();
  }

  private connect(): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.schedule();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.retryMs = 1000;
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.send({ t: 'PING' }), 20_000);
      this.onState(true);
    };
    ws.onmessage = (e) => {
      try { this.onMsg(JSON.parse(String(e.data)) as Hub2S); } catch { /* */ }
    };
    ws.onclose = () => {
      const was = this.connected;
      this.connected = false;
      this.ws = null;
      clearInterval(this.pingTimer);
      if (was) this.onState(false);
      if (this.url) this.schedule();
    };
    ws.onerror = () => { /* onclose следом */ };
  }

  private schedule(): void {
    if (this.retryTimer || !this.url) return;
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.connect(); }, this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 10_000);
  }

  send(m: S2Hub): boolean {
    if (!this.connected || !this.ws) return false;
    try { this.ws.send(JSON.stringify(m)); return true; } catch { return false; }
  }

  close(): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    clearInterval(this.pingTimer);
    const ws = this.ws;
    this.ws = null;
    if (this.connected) { this.connected = false; this.onState(false); }
    try { ws?.close(); } catch { /* */ }
  }
}
