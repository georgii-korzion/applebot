// Уведомления (BOT-SPEC §12): отдельная очередь, никогда не задерживает покупку.
// Каналы: Telegram (по флагу), HTTP-вебхуки (HMAC), текстовые файлы в runtime/ (заказы и все уведомления).
import { appendFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import type { BotConfig, Secrets } from '../config';
import { Telegram, type TgCommand } from './telegram';
import { LOUD, NOTIFY_EVENTS, STATUS_ONLY, humanButtons, orderFileBlock, telegramText, type NotifyEvent } from './templates';

const RETRY_PAUSES = [1000, 3000, 10_000];

export function sign(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export class Notifier {
  tg: Telegram | null = null;
  private statusMsgId: number | null = null;
  private lastStatus = '';
  private statusTimer: ReturnType<typeof setInterval> | undefined;
  private webhookChain = new Map<string, Promise<unknown>>();
  sent: { event: string; channel: string; ok: boolean; at: number }[] = [];

  constructor(
    private cfg: BotConfig,
    private sec: Secrets,
    private files: { orders: string; notify: string },
    private log: (msg: string, level?: 'info' | 'warn') => void,
    onCommand: (c: TgCommand) => Promise<string | void> | string | void,
  ) {
    if (cfg.notify.telegram.enabled && sec.telegram.botToken && sec.telegram.chatId) {
      this.tg = new Telegram(sec.telegram.botToken, sec.telegram.chatId, cfg.notify.telegram.apiBase, sec.telegram.allowedUserIds, onCommand, (m) => log(m, 'warn'));
    }
  }

  start(statusText: () => string): void {
    if (!this.tg) return;
    this.tg.startPolling();
    if (this.cfg.notify.telegram.liveStatus) {
      this.statusTimer = setInterval(() => void this.pushStatus(statusText()), this.cfg.notify.telegram.statusEditMs);
    }
  }

  stop(): void {
    clearInterval(this.statusTimer);
    this.tg?.stop();
  }

  private async pushStatus(text: string): Promise<void> {
    if (!this.tg || text === this.lastStatus) return;
    this.lastStatus = text;
    if (this.statusMsgId === null) {
      this.statusMsgId = -1;
      const id = await this.tg.send(text, { silent: true });
      if (id) { this.statusMsgId = id; await this.tg.pin(id); } else this.statusMsgId = null;
      return;
    }
    if (this.statusMsgId > 0) await this.tg.edit(this.statusMsgId, text);
  }

  /** Событие наружу. Никогда не бросает и не ждёт сеть. */
  emit(e: NotifyEvent): void {
    if (!(NOTIFY_EVENTS as readonly string[]).includes(e.event)) return;
    const text = telegramText(e);
    try {
      appendFileSync(this.files.notify, `[${e.ts}] ${text.replace(/\n/g, '\n    ')}\n`, { mode: 0o600 });
      if (e.event === 'order.placed' && this.cfg.notify.file.enabled) appendFileSync(this.files.orders, `${orderFileBlock(e)}\n`, { mode: 0o600 });
    } catch (err) { this.log(`файл уведомлений: ${err}`, 'warn'); }
    if (this.tg && !STATUS_ONLY.has(e.event)) {
      const buttons = e.event === 'human.needed' && e.browser ? humanButtons(e.browser) : undefined;
      void this.tg.send(text, { silent: !LOUD.has(e.event), buttons }).then((id) => this.sent.push({ event: e.event, channel: 'telegram', ok: !!id, at: Date.now() }));
    }
    if (this.cfg.notify.webhooks.enabled && this.sec.webhooks.length) {
      const allow = this.cfg.notify.webhooks.events;
      if (!allow.length || allow.includes(e.event)) for (const w of this.sec.webhooks) this.webhook(w.url, w.secret, e);
    }
  }

  /** Скриншот в Telegram (QR — только если sendQrScreenshot; владелец решил не слать). */
  photo(png: Buffer, caption: string): void {
    if (this.tg) void this.tg.photo(png, caption);
  }

  private webhook(url: string, secret: string, e: NotifyEvent): void {
    const body = JSON.stringify(e);
    const prev = this.webhookChain.get(url) ?? Promise.resolve();
    const next = prev.then(async () => {
      for (let attempt = 0; attempt <= RETRY_PAUSES.length; attempt++) {
        try {
          const r = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-signature': sign(body, secret), 'x-event': e.event },
            body,
            signal: AbortSignal.timeout(8000),
          });
          if (r.ok) { this.sent.push({ event: e.event, channel: 'webhook', ok: true, at: Date.now() }); return; }
          if (r.status >= 400 && r.status < 500 && r.status !== 429) break;
        } catch { /* сеть */ }
        if (attempt < RETRY_PAUSES.length) await new Promise((res) => setTimeout(res, RETRY_PAUSES[attempt]));
      }
      this.sent.push({ event: e.event, channel: 'webhook', ok: false, at: Date.now() });
      this.log(`вебхук ${new URL(url).host}: ${e.event} не доставлен`, 'warn');
    });
    this.webhookChain.set(url, next.catch(() => {}));
  }
}
