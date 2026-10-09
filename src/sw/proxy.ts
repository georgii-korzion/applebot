// Прокси профиля из конфига (FLEET-SPEC §7): chrome.proxy.settings + ответ на auth-challenge прокси.
// Только прокси целиком на профиль; хаб и служебные хосты Google — мимо прокси (bypassList).
import type { ProxyCfg } from '../shared/config';

type Log = (msg: string, level?: 'info' | 'warn' | 'error') => void;

const DEFAULT_BYPASS = ['127.0.0.1', 'localhost', '*.google.com', '*.gstatic.com', '*.googleapis.com', '*.gvt1.com'];

export function hubHostOf(hubUrl: string): string | null {
  try { return hubUrl ? new URL(hubUrl).hostname : null; } catch { return null; }
}

/** Ключ для сравнения «тот же прокси» (без пароля в тексте). */
export function proxyKey(p: ProxyCfg | null, hubUrl: string): string {
  return p ? `${p.scheme}://${p.username ?? ''}@${p.host}:${p.port}|${(p.bypass ?? []).join(',')}|${hubHostOf(hubUrl) ?? ''}` : '';
}

export function proxyLabel(p: ProxyCfg | null): string {
  return p ? `${p.scheme}://${p.host}:${p.port}${p.username ? ' (с логином)' : ''}` : 'напрямую';
}

/** Применить прокси (или снять) для всего профиля. Ошибки — в лог, покупку не останавливают. */
export async function applyProxy(p: ProxyCfg | null, hubUrl: string, log: Log): Promise<boolean> {
  if (!chrome.proxy?.settings) { log('chrome.proxy недоступен (нет права proxy в manifest?) — прокси не применён', 'warn'); return false; }
  try {
    if (!p) {
      await chrome.proxy.settings.clear({ scope: 'regular' });
      return true;
    }
    const bypassList = p.bypass?.length ? [...p.bypass] : [...DEFAULT_BYPASS];
    const hubHost = hubHostOf(hubUrl);
    if (hubHost && !p.bypass?.length && !bypassList.includes(hubHost)) bypassList.push(hubHost);
    const value: chrome.proxy.ProxyConfig = {
      mode: 'fixed_servers',
      rules: { singleProxy: { scheme: p.scheme, host: p.host, port: p.port }, bypassList },
    };
    await chrome.proxy.settings.set({ value, scope: 'regular' });
    return true;
  } catch (e) {
    log(`прокси ${proxyLabel(p)}: не удалось применить — ${e}`, 'warn');
    return false;
  }
}

/**
 * Логин/пароль прокси. Слушатель регистрируется синхронно при старте SW; учётные данные берутся
 * через getCreds() в момент challenge (конфиг может ещё грузиться — поэтому asyncBlocking).
 */
export function initProxyAuth(getCreds: () => Promise<{ username: string; password: string } | null>, log: Log): void {
  if (!chrome.webRequest?.onAuthRequired) return;
  const answered = new Set<string>();
  try {
    chrome.webRequest.onAuthRequired.addListener(
      (details, callback): chrome.webRequest.BlockingResponse | undefined => {
        void (async () => {
          if (!details.isProxy) { callback?.({}); return; }
          if (answered.has(details.requestId)) {
            answered.delete(details.requestId);
            log(`прокси отверг логин (${details.challenger?.host ?? '?'}) — запрос отменён`, 'warn');
            callback?.({ cancel: true });
            return;
          }
          const creds = await getCreds();
          if (!creds) { callback?.({}); return; }
          answered.add(details.requestId);
          setTimeout(() => answered.delete(details.requestId), 60_000);
          callback?.({ authCredentials: creds });
        })();
        return undefined;
      },
      { urls: ['<all_urls>'] },
      ['asyncBlocking'],
    );
  } catch (e) {
    log(`onAuthRequired не зарегистрирован: ${e}`, 'warn');
  }
  chrome.proxy?.onProxyError?.addListener((d) => log(`ошибка прокси: ${d.error} ${d.details ?? ''}`.trim(), 'warn'));
}

/** Выходной IP через fetch (идёт через прокси профиля, если он задан). */
export async function fetchEgress(url: string): Promise<{ ip?: string; country?: string }> {
  const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = (await r.json()) as Record<string, unknown>;
  const ip = typeof j.ip === 'string' ? j.ip : typeof j.query === 'string' ? j.query : undefined;
  const country = typeof j.country === 'string' ? j.country : typeof j.country_code === 'string' ? j.country_code : typeof j.countryCode === 'string' ? j.countryCode : undefined;
  return { ip, country: country?.toUpperCase() };
}
