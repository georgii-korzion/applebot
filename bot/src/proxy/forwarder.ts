// Локальный форвардер прокси (BOT-SPEC §8): Chrome не принимает логин/пароль в --proxy-server, поэтому
// браузер ходит на 127.0.0.1:<порт> без авторизации, а форвардер — в настоящий прокси (HTTP CONNECT или SOCKS5)
// с логином. Живость: проба раз в 3 с; ошибки дольше downAfterSec → событие down (PROXY_DOWN).
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';

export interface Upstream { protocol: 'http' | 'https' | 'socks5'; host: string; port: number; user?: string; pass?: string }

export function parseProxyUrl(url: string): Upstream {
  const u = new URL(url);
  const proto = u.protocol.replace(':', '').toLowerCase();
  const protocol: Upstream['protocol'] = proto.startsWith('socks') ? 'socks5' : proto === 'https' ? 'https' : 'http';
  return {
    protocol, host: u.hostname, port: Number(u.port || (protocol === 'socks5' ? 1080 : protocol === 'https' ? 443 : 8080)),
    user: u.username ? decodeURIComponent(u.username) : undefined, pass: u.password ? decodeURIComponent(u.password) : undefined,
  };
}

/** Адрес прокси без пароля — для логов и дашборда. */
export function redactProxy(url: string): string {
  try { const u = new URL(url); return `${u.protocol}//${u.username ? `${decodeURIComponent(u.username)}:***@` : ''}${u.host}`; } catch { return '***'; }
}

function connectRaw(up: Upstream, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s: net.Socket = up.protocol === 'https'
      ? tls.connect({ host: up.host, port: up.port, servername: up.host })
      : net.connect({ host: up.host, port: up.port });
    const t = setTimeout(() => { s.destroy(); reject(new Error(`прокси ${up.host}:${up.port}: таймаут соединения`)); }, timeoutMs);
    s.once(up.protocol === 'https' ? 'secureConnect' : 'connect', () => { clearTimeout(t); resolve(s); });
    s.once('error', (e) => { clearTimeout(t); reject(e); });
  });
}

/** Читатель байтов из сокета (для рукопожатий). */
function reader(s: net.Socket) {
  let buf = Buffer.alloc(0);
  const waiters: (() => void)[] = [];
  const onData = (d: Buffer) => { buf = Buffer.concat([buf, d]); for (const w of waiters.splice(0)) w(); };
  s.on('data', onData);
  return {
    async read(n: number, timeoutMs: number): Promise<Buffer> {
      const end = Date.now() + timeoutMs;
      while (buf.length < n) {
        if (Date.now() > end) throw new Error('прокси: таймаут ответа');
        await new Promise<void>((r) => { const t = setTimeout(r, 200); waiters.push(() => { clearTimeout(t); r(); }); });
        if (s.destroyed && buf.length < n) throw new Error('прокси закрыл соединение');
      }
      const out = buf.subarray(0, n);
      buf = buf.subarray(n);
      return out;
    },
    async readUntil(marker: string, timeoutMs: number): Promise<Buffer> {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const i = buf.indexOf(marker);
        if (i >= 0) { const out = buf.subarray(0, i + marker.length); buf = buf.subarray(i + marker.length); return out; }
        if (Date.now() > end) throw new Error('прокси: таймаут ответа');
        if (s.destroyed) throw new Error('прокси закрыл соединение');
        await new Promise<void>((r) => { const t = setTimeout(r, 200); waiters.push(() => { clearTimeout(t); r(); }); });
      }
    },
    /** Отцепиться, вернуть непрочитанное в поток. */
    release(): void { s.off('data', onData); if (buf.length) s.unshift(buf); buf = Buffer.alloc(0); },
  };
}

/** Туннель к host:port через апстрим: HTTP CONNECT (Proxy-Authorization) или SOCKS5 (логин/пароль). */
export async function openTunnel(up: Upstream, host: string, port: number, timeoutMs = 10_000): Promise<net.Socket> {
  const s = await connectRaw(up, timeoutMs);
  const r = reader(s);
  try {
    if (up.protocol === 'socks5') {
      const methods = up.user ? [0x00, 0x02] : [0x00];
      s.write(Buffer.from([0x05, methods.length, ...methods]));
      const [ver, method] = await r.read(2, timeoutMs);
      if (ver !== 0x05 || method === 0xff) throw new Error('SOCKS5: метод авторизации не принят');
      if (method === 0x02) {
        const u = Buffer.from(up.user ?? ''), p = Buffer.from(up.pass ?? '');
        s.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
        const [, st] = await r.read(2, timeoutMs);
        if (st !== 0x00) throw new Error('SOCKS5: неверный логин/пароль');
      }
      const h = Buffer.from(host);
      s.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]), h, Buffer.from([port >> 8, port & 0xff])]));
      const head = await r.read(4, timeoutMs);
      if (head[1] !== 0x00) throw new Error(`SOCKS5: отказ соединения (код ${head[1]})`);
      const atyp = head[3];
      const alen = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : (await r.read(1, timeoutMs))[0];
      await r.read(alen + 2, timeoutMs);
    } else {
      const auth = up.user ? `Proxy-Authorization: Basic ${Buffer.from(`${up.user}:${up.pass ?? ''}`).toString('base64')}\r\n` : '';
      s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
      const resp = (await r.readUntil('\r\n\r\n', timeoutMs)).toString('latin1');
      const code = Number(/^HTTP\/\d\.\d (\d{3})/.exec(resp)?.[1] ?? 0);
      if (code !== 200) throw new Error(`прокси ответил ${code || '?'} на CONNECT${code === 407 ? ' (неверный логин/пароль)' : ''}`);
    }
    r.release();
    return s;
  } catch (e) {
    s.destroy();
    throw e;
  }
}

function proxyAuthHeader(up: Upstream): string | undefined {
  return up.user ? `Basic ${Buffer.from(`${up.user}:${up.pass ?? ''}`).toString('base64')}` : undefined;
}

export interface ForwarderStatus { id: string; port: number; up: boolean; lastOkAt?: number; failingSince?: number; lastError?: string; errors: number; connects: number }

export class Forwarder extends EventEmitter {
  private server: http.Server | null = null;
  private probeTimer: ReturnType<typeof setInterval> | undefined;
  private sockets = new Set<net.Socket>();
  up = true;
  lastOkAt?: number;
  failingSince?: number;
  lastError?: string;
  errors = 0;
  connects = 0;
  /** Куда ходили через форвардер (host:port) — для проверки, что хаб идёт мимо прокси. */
  targets = new Map<string, number>();

  constructor(readonly id: string, readonly upstream: Upstream, readonly port: number, private opts: { probe: string; downAfterSec: number }) {
    super();
  }

  async start(): Promise<void> {
    const srv = http.createServer((req, res) => this.onRequest(req, res));
    srv.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => this.onConnect(req, client, head));
    srv.on('connection', (s: net.Socket) => { this.sockets.add(s); s.on('close', () => this.sockets.delete(s)); });
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(this.port, '127.0.0.1', () => resolve());
    });
    this.server = srv;
    this.probeTimer = setInterval(() => void this.probe(), 3000);
    void this.probe();
  }

  stop(): void {
    clearInterval(this.probeTimer);
    for (const s of this.sockets) s.destroy();
    this.server?.close();
    this.server = null;
  }

  status(): ForwarderStatus {
    return { id: this.id, port: this.port, up: this.up, lastOkAt: this.lastOkAt, failingSince: this.failingSince, lastError: this.lastError, errors: this.errors, connects: this.connects };
  }

  private ok(): void {
    this.lastOkAt = Date.now();
    this.failingSince = undefined;
    if (!this.up) { this.up = true; this.emit('up'); }
  }

  private fail(e: unknown): void {
    this.errors++;
    this.lastError = e instanceof Error ? e.message : String(e);
    const now = Date.now();
    this.failingSince ??= now;
    if (this.up && now - this.failingSince >= this.opts.downAfterSec * 1000) {
      this.up = false;
      this.emit('down', this.lastError);
    }
  }

  private async probe(): Promise<void> {
    const [host, port] = this.opts.probe.split(':');
    try {
      const s = await openTunnel(this.upstream, host, Number(port || 443), 8000);
      s.destroy();
      this.ok();
    } catch (e) {
      this.fail(e);
    }
  }

  private count(target: string): void {
    this.connects++;
    this.targets.set(target, (this.targets.get(target) ?? 0) + 1);
  }

  private onConnect(req: http.IncomingMessage, client: net.Socket, head: Buffer): void {
    const target = req.url ?? '';
    const i = target.lastIndexOf(':');
    const host = target.slice(0, i).replace(/^\[|\]$/g, '');
    const port = Number(target.slice(i + 1)) || 443;
    this.count(`${host}:${port}`);
    client.on('error', () => {});
    openTunnel(this.upstream, host, port).then((up) => {
      this.ok();
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) up.write(head);
      up.on('error', () => client.destroy());
      client.on('error', () => up.destroy());
      up.pipe(client);
      client.pipe(up);
    }, (e) => {
      this.fail(e);
      client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
  }

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // запрос не через прокси (origin-form) — это оркестратор спрашивает статус
    if ((req.url ?? '').startsWith('/__status')) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ...this.status(), pid: process.pid, targets: Object.fromEntries(this.targets) }));
      return;
    }
    let target: URL;
    try { target = new URL(req.url ?? ''); } catch { res.writeHead(400); res.end(); return; }
    const port = Number(target.port || 80);
    this.count(`${target.hostname}:${port}`);
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    const fail = (e: unknown) => { this.fail(e); if (!res.headersSent) { res.writeHead(502); res.end(); } else res.destroy(); };
    const onResp = (pres: http.IncomingMessage) => { this.ok(); res.writeHead(pres.statusCode ?? 502, pres.headers); pres.pipe(res); };
    if (this.upstream.protocol !== 'socks5') {
      const auth = proxyAuthHeader(this.upstream);
      if (auth) headers['proxy-authorization'] = auth;
      const preq = http.request({ host: this.upstream.host, port: this.upstream.port, method: req.method, path: req.url, headers });
      preq.on('response', onResp);
      preq.on('error', fail);
      req.pipe(preq);
      return;
    }
    openTunnel(this.upstream, target.hostname, port).then((sock) => {
      const preq = http.request({ createConnection: () => sock, host: target.hostname, port, method: req.method, path: target.pathname + target.search, headers });
      preq.on('response', onResp);
      preq.on('error', fail);
      req.pipe(preq);
    }, fail);
  }
}

/** HTTPS GET через апстрим-прокси (или напрямую): статус, заголовки, тело, время. Для bot check. */
export async function httpsGetVia(up: Upstream | null, url: string, timeoutMs = 10_000): Promise<{ status: number; body: string; ms: number }> {
  const u = new URL(url);
  const t0 = Date.now();
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  const mod = u.protocol === 'https:' ? await import('node:https') : http;
  let sock: net.Socket | undefined;
  if (up) sock = await openTunnel(up, u.hostname, port, timeoutMs);
  return new Promise((resolve, reject) => {
    const req = (mod as typeof http).request({
      host: u.hostname, port, path: u.pathname + u.search, method: 'GET',
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36', accept: '*/*' },
      ...(sock ? { createConnection: () => (u.protocol === 'https:' ? tls.connect({ socket: sock!, servername: u.hostname }) : sock!) } : {}),
      timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (body.length < 200_000) body += d; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, ms: Date.now() - t0 }));
    });
    req.on('timeout', () => req.destroy(new Error('таймаут')));
    req.on('error', reject);
    req.end();
  });
}

/** Статус форвардера по его порту (null — не запущен). */
export async function forwarderStatus(port: number, timeoutMs = 1500): Promise<(ForwarderStatus & { pid: number; targets: Record<string, number> }) | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/__status`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? ((await r.json()) as ForwarderStatus & { pid: number; targets: Record<string, number> }) : null;
  } catch {
    return null;
  }
}

/**
 * Форвардер отдельным процессом (bot forwarder): переживает падение/закрытие оркестратора — браузеры через прокси
 * не теряют сеть и доводят свои заказы (BOT-SPEC §3.5). Адрес прокси с паролем — из переменной окружения PROXY_URL.
 */
export async function runForwarderProcess(id: string, port: number, probe: string, downAfterSec: number): Promise<void> {
  const url = process.env.PROXY_URL ?? '';
  if (!url) throw new Error('PROXY_URL не задан');
  const f = new Forwarder(id, parseProxyUrl(url), port, { probe, downAfterSec });
  f.on('down', (e: string) => console.log(`[${new Date().toISOString()}] ${id} DOWN: ${e}`));
  f.on('up', () => console.log(`[${new Date().toISOString()}] ${id} UP`));
  await f.start();
  console.log(`[${new Date().toISOString()}] форвардер ${id}: 127.0.0.1:${port} → ${redactProxy(url)} (PID ${process.pid})`);
  const stop = () => { f.stop(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
