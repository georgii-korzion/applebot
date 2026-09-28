// Плашка статуса на странице (§7.9): Shadow DOM, правый верхний угол, не перекрывает кнопки Apple.

export interface OverlayData {
  profile: string;
  order: string;
  state: string;
  detail?: string;
  role?: string;
  reloads: number;
  atb404: number;
  timerLabel?: string;
  timerSince?: number;   // epoch ms — «N с назад»
  countdownTo?: number;  // epoch ms — «через N с»
  paused?: boolean;
}

const CSS = `
:host { all: initial; }
.wrap { position: fixed; top: 56px; right: 10px; z-index: 2147483646; font: 12px/1.35 -apple-system, BlinkMacSystemFont, "SF Pro Text", Helvetica, Arial, sans-serif; color: #f5f5f7; pointer-events: none; }
.panel { pointer-events: auto; width: 250px; background: rgba(29,29,31,.92); border-radius: 10px; padding: 8px 10px; box-shadow: 0 4px 18px rgba(0,0,0,.25); }
.panel.min { width: auto; padding: 4px 8px; }
.row { display: flex; justify-content: space-between; gap: 6px; }
.muted { color: #a1a1a6; }
.state { font-weight: 600; font-size: 13px; margin: 2px 0; color: #30d158; word-break: break-word; }
.state.warn { color: #ffd60a; } .state.err { color: #ff453a; }
.detail { color: #d2d2d7; word-break: break-word; max-height: 4.2em; overflow: hidden; }
.btns { display: flex; gap: 6px; margin-top: 6px; }
button { all: unset; cursor: pointer; background: #3a3a3c; color: #f5f5f7; padding: 2px 8px; border-radius: 6px; font-size: 11px; }
button:hover { background: #48484a; }
.banner { pointer-events: auto; position: fixed; left: 50%; transform: translateX(-50%); bottom: 18px; z-index: 2147483647; max-width: min(760px, calc(100vw - 32px)); background: #0071e3; color: #fff; border-radius: 14px; padding: 14px 20px; font-size: 17px; font-weight: 600; box-shadow: 0 8px 30px rgba(0,0,0,.35); text-align: center; }
.banner.ok { background: #248a3d; } .banner.warn { background: #b25000; }
.banner small { display: block; font-size: 12px; font-weight: 400; opacity: .9; margin-top: 4px; }
`;

export class Overlay {
  private host: HTMLElement;
  private root: ShadowRoot;
  private panel: HTMLDivElement;
  private bannerEl: HTMLDivElement | null = null;
  private data: OverlayData = { profile: '', order: '', state: '…', reloads: 0, atb404: 0 };
  private minimized = false;
  private tick: ReturnType<typeof setInterval>;
  onPause: (paused: boolean) => void = () => {};
  onHide: (hidden: boolean) => void = () => {};

  constructor(hidden = false) {
    this.host = document.createElement('apple-drop-assistant');
    this.root = this.host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    this.panel = document.createElement('div');
    this.panel.className = 'panel';
    wrap.append(this.panel);
    this.root.append(style, wrap);
    (document.body ?? document.documentElement).append(this.host);
    this.minimized = hidden;
    this.render();
    this.tick = setInterval(() => this.render(), 500);
  }

  update(d: Partial<OverlayData>): void {
    Object.assign(this.data, d);
    this.render();
  }

  banner(text: string | null, sub?: string, kind: 'info' | 'ok' | 'warn' = 'info'): void {
    if (!text) { this.bannerEl?.remove(); this.bannerEl = null; return; }
    if (!this.bannerEl) {
      this.bannerEl = document.createElement('div');
      this.root.append(this.bannerEl);
    }
    this.bannerEl.className = `banner ${kind === 'info' ? '' : kind}`;
    this.bannerEl.textContent = text;
    if (sub) {
      const s = document.createElement('small');
      s.textContent = sub;
      this.bannerEl.append(s);
    }
  }

  destroy(): void {
    clearInterval(this.tick);
    this.host.remove();
  }

  private render(): void {
    const d = this.data;
    const p = this.panel;
    p.textContent = '';
    p.className = this.minimized ? 'panel min' : 'panel';
    if (this.minimized) {
      const b = document.createElement('button');
      b.textContent = `◉ ${d.state}`;
      b.title = 'Apple Drop Assistant — показать';
      b.onclick = () => { this.minimized = false; this.onHide(false); this.render(); };
      p.append(b);
      return;
    }
    const head = row(`${d.profile || '—'} · заказ ${d.order || '—'}`, d.role ?? '');
    const st = document.createElement('div');
    st.className = 'state' + (/STUCK|TIMEOUT|ERROR/.test(d.state) ? ' err' : /ASSIST|PAUSE|STANDBY|COUNTRY/.test(d.state) ? ' warn' : '');
    st.textContent = d.paused ? `⏸ ${d.state}` : d.state;
    const det = document.createElement('div');
    det.className = 'detail';
    det.textContent = d.detail ?? '';
    const now = Date.now();
    let timer = '';
    if (d.countdownTo) timer = `через ${fmtDur(d.countdownTo - now)}`;
    else if (d.timerSince) timer = `${d.timerLabel ?? ''} ${fmtDur(now - d.timerSince)} назад`.trim();
    const counters = row(`рефреши ${d.reloads} · 404 ${d.atb404}`, timer);
    const btns = document.createElement('div');
    btns.className = 'btns';
    const pause = document.createElement('button');
    pause.textContent = d.paused ? 'Продолжить' : 'Пауза';
    pause.onclick = () => this.onPause(!d.paused);
    const hide = document.createElement('button');
    hide.textContent = 'Скрыть';
    hide.onclick = () => { this.minimized = true; this.onHide(true); this.render(); };
    btns.append(pause, hide);
    p.append(head, st, det, counters, btns);
  }
}

function row(left: string, right: string): HTMLDivElement {
  const r = document.createElement('div');
  r.className = 'row';
  const a = document.createElement('span');
  a.textContent = left;
  const b = document.createElement('span');
  b.className = 'muted';
  b.textContent = right;
  r.append(a, b);
  return r;
}

export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин ${s % 60} с`;
  const h = Math.floor(m / 60);
  return `${h} ч ${m % 60} мин`;
}
