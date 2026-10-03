// Режим бота (docs/BOT-SPEC.md): общие типы для расширения и оркестратора (bot/).
// Расширение в режиме бота получает конфиг от хаба, а не из chrome.storage.local.

export type Strategy = 'refresh' | 'hold';

/** Настройки бота для одного браузера — приходят в CONFIG и лежат в Config.bot. */
export interface BotRuntime {
  browserId: string;
  /** Имя машины (несколько Mac работают независимо, §1) — в записях заказов и уведомлениях. */
  machine: string;
  strategy: Strategy;
  /** hold: сколько ждать заглушку после openAt, потом refresh (§7). */
  holdMaxWaitSec: number;
  /** После OPEN перезагружаться со случайной задержкой 0–500 мс (половина флота, §20.5). */
  openJitter: boolean;
  /** Пробный прогон: стоп на Review, ничего не оплачивать. */
  stopBeforePay: boolean;
  applePay: { cdpClick: boolean; osClick: boolean; timeoutSec: number; reopenTries: number; fullscreen: boolean };
  threeDsTimeoutSec: number;
  /** Add to Bag прямым переходом по URL с токеном сессии вместо клика (§2, §20.6). */
  directAtb: boolean;
  /** declarativeNetRequest: не грузить картинки/видео/шрифты страниц товара и корзины (§20.4). */
  blockHeavy: boolean;
  /** За сколько секунд до openAt открыть корзину и вернуться (прогрев, §20.7); 0 — нет. */
  warmupSec: number;
  /** Снимки заглушек для разбора гипотезы 1 (§7). */
  snapshots: boolean;
  /** Живые тесты: HTML каждого нового шага, включая чекаут (токены вычищает хаб) — для test/fixtures/live (§20). */
  recordPages: boolean;
  /** Пока заказа нет — на какой странице ждать (цели самого приоритетного заказа). */
  lobby: { targets: string[]; stores: string[] };
  /** false — bot prepare: гонку не начинать, ждать команды (§4). */
  autoStart: boolean;
  /** Маскирование в логах (§5). Карта в Telegram/вебхуках — всегда ****1234. */
  privacy: { maskContactsInLogs: boolean; maskCardInLogs: boolean; logTokens: boolean };
}

export function defaultBotRuntime(browserId = 'b01'): BotRuntime {
  return {
    browserId, machine: '', strategy: 'refresh', holdMaxWaitSec: 300, openJitter: true, stopBeforePay: false,
    applePay: { cdpClick: true, osClick: false, timeoutSec: 300, reopenTries: 3, fullscreen: true },
    threeDsTimeoutSec: 300, directAtb: false, blockHeavy: false, warmupSec: 150, snapshots: true, recordPages: false,
    lobby: { targets: [], stores: [] },
    autoStart: true,
    privacy: { maskContactsInLogs: false, maskCardInLogs: true, logTokens: false },
  };
}

export function normalizeBotRuntime(raw: unknown): BotRuntime | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, any>;
  const d = defaultBotRuntime(String(r.browserId ?? 'b01'));
  const n = (v: unknown, def: number) => (Number.isFinite(Number(v)) ? Number(v) : def);
  const b = (v: unknown, def: boolean) => (v === undefined ? def : !!v);
  return {
    browserId: String(r.browserId ?? d.browserId),
    machine: String(r.machine ?? ''),
    strategy: r.strategy === 'hold' ? 'hold' : 'refresh',
    holdMaxWaitSec: n(r.holdMaxWaitSec, d.holdMaxWaitSec),
    openJitter: b(r.openJitter, d.openJitter),
    stopBeforePay: b(r.stopBeforePay, d.stopBeforePay),
    applePay: {
      cdpClick: b(r.applePay?.cdpClick, d.applePay.cdpClick),
      osClick: b(r.applePay?.osClick, d.applePay.osClick),
      timeoutSec: n(r.applePay?.timeoutSec, d.applePay.timeoutSec),
      reopenTries: n(r.applePay?.reopenTries, d.applePay.reopenTries),
      fullscreen: b(r.applePay?.fullscreen, d.applePay.fullscreen),
    },
    threeDsTimeoutSec: n(r.threeDsTimeoutSec, d.threeDsTimeoutSec),
    directAtb: b(r.directAtb, d.directAtb),
    blockHeavy: b(r.blockHeavy, d.blockHeavy),
    warmupSec: n(r.warmupSec, d.warmupSec),
    snapshots: b(r.snapshots, d.snapshots),
    recordPages: b(r.recordPages, d.recordPages),
    lobby: {
      targets: Array.isArray(r.lobby?.targets) ? r.lobby.targets.map(String) : [],
      stores: Array.isArray(r.lobby?.stores) ? r.lobby.stores.map(String) : [],
    },
    autoStart: b(r.autoStart, true),
    privacy: {
      maskContactsInLogs: b(r.privacy?.maskContactsInLogs, d.privacy.maskContactsInLogs),
      maskCardInLogs: b(r.privacy?.maskCardInLogs, d.privacy.maskCardInLogs),
      logTokens: b(r.privacy?.logTokens, d.privacy.logTokens),
    },
  };
}

/** Время шага: всего / сеть / ожидание элемента / пауза в коде (§20, `bot bench`). */
export interface StepPerf { state: string; ms: number; net: number; wait: number; pause: number }

export interface Rect { x: number; y: number; w: number; h: number }

/** Куда кликать «настоящим» кликом: прямоугольник в CSS-пикселях окна и оценка экранных координат (§9.2). */
export interface ClickTarget { rect: Rect; screen: { x: number; y: number }; dpr: number }

export type PayWaitKind = '3ds' | 'applepay_qr';

/** Причины, по которым нужен человек (§10) — порядок = приоритет очереди внимания. */
export type HumanReason =
  | '3ds_input' | 'applepay_qr' | 'payment' | 'captcha' | 'assist' | 'blocked' | 'stuck'
  | 'validation' | 'proxy_down' | 'dead' | 'other';

export const HUMAN_PRIORITY: Record<HumanReason, number> = {
  '3ds_input': 1, applepay_qr: 2, payment: 3, captcha: 4, assist: 5, blocked: 6, stuck: 6, validation: 6, proxy_down: 6, dead: 6, other: 7,
};

/** Команды хаба браузеру (§13 COMMAND). */
export type BotCommand = 'focus' | 'unfocus' | 'stop' | 'resume' | 'manual' | 'reload_target' | 'reload' | 'prepare' | 'clean' | 'snapshot';

/** Тексты явного отказа карты (§9.3) — стартовый набор, уточнить по T12b. */
export const DECLINE_RE = [
  /declin/i,
  /(not|couldn.t be|could not be) authori[sz]ed/i,
  /authori[sz]ation failed/i,
  /unable to (process|verify|authori[sz]e).{0,40}(payment|card)/i,
  /(different|another) (card|payment)/i,
  /contact your (bank|card issuer)/i,
  /payment (method|information|details).{0,60}(invalid|problem|issue|not valid)/i,
];

export function isDeclineText(t: string): boolean {
  return DECLINE_RE.some((re) => re.test(t));
}

/** Признаки 3-D Secure / подтверждения в банке на странице (§9.1). */
export const THREEDS_RE = /(3-?D ?Secure|verify (it.s you|your (identity|payment))|authenticat|confirm (the |this |your )?(payment|purchase)|bank app|your bank|one.?time (pass(word|code)|code)|\bOTP\b|approve (the |this )?(payment|purchase))/i;
