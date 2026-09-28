// Логи (§7.10): формат строки, маскирование, кольцевой буфер в chrome.storage.local.

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function clock(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** «+3.120» после OPEN, «T-47.9» до (от openAt). */
export function rel(ts: number, openedAt?: number, openAt?: number): string {
  if (openedAt) return `+${((ts - openedAt) / 1000).toFixed(3)}`;
  if (openAt && Number.isFinite(openAt)) {
    const s = (ts - openAt) / 1000;
    return s < 0 ? `T${s.toFixed(1)}` : `T+${s.toFixed(1)}`;
  }
  return '+—';
}

/** `[HH:MM:SS.mmm +сек от OPEN] [profile · order · tab] состояние: текст` */
export function fmtLine(p: {
  ts: number; openedAt?: number; openAt?: number; profile: string; order: string; tab: string | number;
  state?: string; msg: string; level?: string;
}): string {
  const lvl = p.level && p.level !== 'info' ? ` ${p.level.toUpperCase()}` : '';
  return `[${clock(p.ts)} ${rel(p.ts, p.openedAt, p.openAt)}] [${p.profile} · ${p.order} · ${p.tab}]${lvl} ${p.state ?? '-'}: ${p.msg}`;
}

// ---------- маскирование ----------
export function maskEmail(e: string): string {
  const m = /^([^@]{0,2})[^@]*@(.)[^.]*(\..+)$/.exec(e.trim());
  return m ? `${m[1]}***@${m[2]}***${m[3]}` : e ? '***' : '';
}

export function maskPhone(p: string): string {
  const s = p.replace(/\D/g, '');
  return s.length >= 6 ? `${s.slice(0, 2)}******${s.slice(-2)}` : s ? '***' : '';
}

export function maskName(n: string): string {
  return n ? `${n[0]}.` : '';
}

/** URL без секретов: atbtoken до 4 символов, прочие известные токены — скрыть. */
export function maskUrl(u: string): string {
  return u
    .replace(/(atbtoken=)([^&#]{0,4})[^&#]*/gi, '$1$2…')
    .replace(/([?&](?:ssi|_a_token|token|signKey|timeSlotId)=)[^&#]*/gi, '$1…');
}

/** Защита от случайной утечки: email/телефон/длинные hex в тексте лога. */
export function scrub(msg: string): string {
  return maskUrl(msg)
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, (m) => maskEmail(m))
    .replace(/\b0?5\d{8}\b/g, (m) => maskPhone(m))
    .replace(/\b[0-9a-f]{24,}\b/gi, (m) => `${m.slice(0, 4)}…`);
}

// ---------- кольцевой буфер (только в SW) ----------
export const LOG_MAX = 5000;

export class LogStore {
  private buf: string[] = [];
  private loaded = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: string[] = [];

  async load(): Promise<void> {
    if (this.loaded) return;
    const s = await chrome.storage.local.get('log');
    const saved: string[] = Array.isArray(s.log) ? s.log : [];
    // строки, пришедшие до загрузки, — в конец
    this.buf = [...saved, ...this.pending].slice(-LOG_MAX);
    this.pending = [];
    this.loaded = true;
  }

  push(line: string): void {
    if (!this.loaded) this.pending.push(line);
    else {
      this.buf.push(line);
      if (this.buf.length > LOG_MAX) this.buf.splice(0, this.buf.length - LOG_MAX);
    }
    console.log(line);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 700);
  }

  async flush(): Promise<void> {
    if (!this.loaded) await this.load();
    await chrome.storage.local.set({ log: this.buf });
  }

  tail(n: number): string[] {
    return (this.loaded ? this.buf : this.pending).slice(-n);
  }

  all(): string[] {
    return this.loaded ? [...this.buf] : [...this.pending];
  }

  async clear(): Promise<void> {
    this.buf = [];
    this.pending = [];
    await chrome.storage.local.set({ log: [] });
  }
}
