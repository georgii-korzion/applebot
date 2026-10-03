// Telegram Bot API (BOT-SPEC §11, §12): сообщения, закреплённый статус (правка не чаще раза в 3 с),
// фото, команды через long polling (публичный адрес не нужен), кнопки. Команды — только от allowedUserIds.

export interface TgCommand { cmd: string; args: string[]; from: number; chatId: string; callbackId?: string }

export class Telegram {
  private offset = 0;
  private polling = false;
  private stopped = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private token: string,
    readonly chatId: string,
    private apiBase: string,
    private allowed: number[],
    private onCommand: (c: TgCommand) => Promise<string | void> | string | void,
    private log: (msg: string) => void = () => {},
  ) {}

  private url(method: string): string {
    return `${this.apiBase}/bot${this.token}/${method}`;
  }

  async call<T = any>(method: string, params: Record<string, unknown> | FormData, timeoutMs = 15_000): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const isForm = typeof FormData !== 'undefined' && params instanceof FormData;
      const r = await fetch(this.url(method), {
        method: 'POST',
        headers: isForm ? undefined : { 'content-type': 'application/json' },
        body: isForm ? (params as FormData) : JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; parameters?: { retry_after?: number } };
      if (j.ok) return j.result as T;
      if (r.status === 429 && j.parameters?.retry_after) { await new Promise((res) => setTimeout(res, (j.parameters!.retry_after! + 0.5) * 1000)); continue; }
      throw new Error(`Telegram ${method}: ${j.description ?? r.status}`);
    }
    throw new Error(`Telegram ${method}: слишком часто`);
  }

  /** Последовательная отправка: сообщения не обгоняют друг друга и не блокируют покупку. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T | null> {
    const p = this.chain.then(fn, fn).catch((e) => { this.log(`telegram: ${e instanceof Error ? e.message : e}`); return null; });
    this.chain = p;
    return p as Promise<T | null>;
  }

  send(text: string, opts: { buttons?: { text: string; callback_data: string }[][]; silent?: boolean } = {}): Promise<number | null> {
    return this.enqueue(async () => {
      const m = await this.call<{ message_id: number }>('sendMessage', {
        chat_id: this.chatId, text: text.slice(0, 4000), disable_web_page_preview: true, disable_notification: !!opts.silent,
        ...(opts.buttons ? { reply_markup: { inline_keyboard: opts.buttons } } : {}),
      });
      return m.message_id;
    });
  }

  edit(messageId: number, text: string): Promise<unknown> {
    return this.enqueue(() => this.call('editMessageText', { chat_id: this.chatId, message_id: messageId, text: text.slice(0, 4000), disable_web_page_preview: true }));
  }

  pin(messageId: number): Promise<unknown> {
    return this.enqueue(() => this.call('pinChatMessage', { chat_id: this.chatId, message_id: messageId, disable_notification: true }));
  }

  photo(png: Buffer, caption: string): Promise<unknown> {
    return this.enqueue(() => {
      const fd = new FormData();
      fd.append('chat_id', this.chatId);
      fd.append('caption', caption.slice(0, 1000));
      fd.append('photo', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'screen.png');
      return this.call('sendPhoto', fd, 30_000);
    });
  }

  startPolling(): void {
    if (this.polling) return;
    this.polling = true;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const ups = await this.call<any[]>('getUpdates', { offset: this.offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, 35_000);
        for (const u of ups) {
          this.offset = Math.max(this.offset, u.update_id + 1);
          await this.onUpdate(u);
        }
      } catch (e) {
        if (!this.stopped) await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  private async onUpdate(u: any): Promise<void> {
    const cb = u.callback_query;
    const msg = u.message;
    const from = Number(cb?.from?.id ?? msg?.from?.id);
    const chatId = String(cb?.message?.chat?.id ?? msg?.chat?.id ?? '');
    let text: string = cb ? String(cb.data ?? '') : String(msg?.text ?? '');
    if (!text) return;
    if (!this.allowed.includes(from)) {
      this.log(`telegram: команда от ${from} отклонена (нет в allowedUserIds)`);
      if (cb) await this.call('answerCallbackQuery', { callback_query_id: cb.id, text: 'нет доступа' }).catch(() => {});
      return;
    }
    if (cb) text = `/${text.replace(':', ' ')}`;
    if (!text.startsWith('/')) return;
    const [head, ...args] = text.trim().split(/\s+/);
    const cmd = head.slice(1).split('@')[0].toLowerCase();
    let reply: string | void;
    try { reply = await this.onCommand({ cmd, args, from, chatId, callbackId: cb?.id }); } catch (e) { reply = `ошибка: ${e instanceof Error ? e.message : e}`; }
    if (cb) await this.call('answerCallbackQuery', { callback_query_id: cb.id, text: (reply ?? 'ok').slice(0, 190) }).catch(() => {});
    else if (reply) await this.send(reply, { silent: true });
  }
}
