// Макет apple.com/ae для тестов расширения (§11.1). Без зависимостей.
//   node test/mock-server.mjs
// Переменные окружения (или POST /__config JSON с теми же ключами в camelCase):
//   PORT=4777
//   OPEN_AFTER=20          через сколько секунд «открываются продажи» Duo (18 Pro открыт всегда)
//   BUSY_FIRST=1           «Almost there» (503) на первый заход сессии на конфигурацию после открытия
//   ATB_404_RATE=0         доля 404 на Add to Bag; 404 всегда без acpart=none или с неверным atbtoken
//   ATB_404_FIRST=0        первые N попыток Add to Bag каждой сессии — 404
//   ACPART_DELAY_MS=250    задержка ответа updateSummary
//   COUNTRY_PICKER=0       баннер выбора страны для сессии без cookie geo=AE
//   REQUIRE_TRUSTED=0      Add to Bag только от настоящего клика (hx=1 ставит pointerdown)
//   UNAVAILABLE_STORES=R597  магазины без наличия
//   TAKEN_FIRST_SLOT=1     первое окно каждой даты «уже занято»
//   HYDRATE_MS=250         задержка «гидратации» страницы конфигурации
//   ATTACH_DELAY_MS=900    200 → beacon/atb → step=attach
//   THREEDS_MS=0           после Place Order — «подтверди в приложении банка» N мс, потом thank-you (3-D Secure)
//   CARD_DELAY_MS=0        блок карты на Billing появляется через N мс после выбора «Credit or Debit Card» (Apple 30.09: несколько секунд)
//   DEFAULT_CITY=Dubai     город в чекауте по умолчанию
//   QUEUE_AFTER_OPEN=0     после открытия первые N заходов сессии на страницу товара — «очередь» с meta refresh (2 с),
//                          страница сама ведёт дальше; ручные рефреши очереди считаются (queueReloads)
//   CHECKOUT_ERR_FIRST=0   первый Continue на Fulfillment и первый Continue to Payment — ошибка общего вида
//   EMPTY_BAG_FIRST=0      первый Add to Bag сессии проходит (step=attach), но корзина остаётся пустой
//   RENAME_AUTOM=1         все data-autom переименованы (Apple сменила селекторы) — расширение ищет по тексту/атрибутам
//   STORE_CLOSED=          магазин закрыт до открытия продаж (все /ae/shop/*):
//                            blank    — пустая страница (200), JSON — 503
//                            backsoon — «We’ll be back.» (503) по тому же адресу
//                            redirect — 302 на /ae/shop/backsoon
//                            offsite  — 302 на /shop/backsoon (вне /ae/, content script там не работает)
// Бот (docs/BOT-SPEC.md §15):
//   ADMIT_MODE=refresh     до открытия — заглушка; пускает только тех, кто загрузил страницу после открытия
//   ADMIT_MODE=queue       заглушка сама пускает случайные ожидающие сессии по одной раз в ADMIT_EVERY_MS (2000);
//                          перезагрузка сбрасывает место (ждать нужно ADMIT_MIN_WAIT_MS=3000 без перезагрузки)
//   DECLINE_LAST4=1111     Place Order с этими картами → явный отказ на Review
//   PLACE_GENERIC_ERR=1    после Place Order — общая ошибка без слов про карту
//   APPLEPAY_TRUSTED_ONLY=1  QR Apple Pay открывается только от настоящего клика
//   APPLEPAY_QR_EXPIRE_MS  QR закрывается сам через N мс
//   BLOCK_AFTER_SESSIONS=N после N сессий с одного адреса клиента — 403 Access Denied
//                          (адрес — заголовок x-test-exit-ip от тестового прокси, иначе 127.0.0.1)
//   CAPTCHA_AT=<шаг>       product | bag | signin | checkout: проверка «я не робот», проходит только настоящий клик
//   HANG_STORES=1          список магазинов на Fulfillment «ищется» бесконечно (зависание для сторожа)
//   ?stale404=1 на адресе товара — 404 «can’t be found» с фразой заглушки в подвале (ловушка классификации)
// Служебное: GET /__state, POST /__reset, POST /__config, POST /__addr_sessions {addr, n}
import http from 'node:http';
import crypto from 'node:crypto';

const env = process.env;
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const S = {
  port: num(env.PORT, 4777),
  openAfter: num(env.OPEN_AFTER, 20),
  busyFirst: env.BUSY_FIRST !== '0',
  atb404Rate: num(env.ATB_404_RATE, 0),
  atb404First: num(env.ATB_404_FIRST, 0),
  acpartDelayMs: num(env.ACPART_DELAY_MS, 250),
  countryPicker: env.COUNTRY_PICKER === '1',
  requireTrusted: env.REQUIRE_TRUSTED === '1',
  unavailableStores: (env.UNAVAILABLE_STORES ?? 'R597').split(',').filter(Boolean),
  takenFirstSlot: env.TAKEN_FIRST_SLOT !== '0',
  hydrateMs: num(env.HYDRATE_MS, 250),
  attachDelayMs: num(env.ATTACH_DELAY_MS, 900),
  cardDelayMs: num(env.CARD_DELAY_MS, 0),
  threeDsMs: num(env.THREEDS_MS, 0),
  defaultCity: env.DEFAULT_CITY ?? 'Dubai',
  storeClosed: env.STORE_CLOSED ?? '',
  queueAfterOpen: num(env.QUEUE_AFTER_OPEN, 0),
  checkoutErrFirst: env.CHECKOUT_ERR_FIRST === '1',
  emptyBagFirst: env.EMPTY_BAG_FIRST === '1',
  renameAutom: env.RENAME_AUTOM === '1',
  admitMode: env.ADMIT_MODE ?? '',
  admitEveryMs: num(env.ADMIT_EVERY_MS, 2000),
  admitMinWaitMs: num(env.ADMIT_MIN_WAIT_MS, 3000),
  declineLast4: (env.DECLINE_LAST4 ?? '').split(',').filter(Boolean),
  placeGenericErr: env.PLACE_GENERIC_ERR === '1',
  applePayTrustedOnly: env.APPLEPAY_TRUSTED_ONLY === '1',
  applePayQrExpireMs: num(env.APPLEPAY_QR_EXPIRE_MS, 0),
  blockAfterSessions: num(env.BLOCK_AFTER_SESSIONS, 0),
  captchaAt: env.CAPTCHA_AT ?? '',
  hangStores: env.HANG_STORES === '1',
};
const placeLog = [];
const addrSessions = new Map();
// адрес клиента: x-test-exit-ip от тестового HTTP-прокси, иначе адрес сокета (SOCKS-прокси теста выходит с 127.0.0.2)
const clientAddr = (req) => String(req.headers['x-test-exit-ip'] ?? String(req.socket.remoteAddress ?? '127.0.0.1').replace(/^::ffff:/, ''));
let openAt = Date.now() + S.openAfter * 1000;

// ---------- каталог (как src/shared/parts.ts) ----------
const PARTS = {};
const cap = (c) => c.toUpperCase();
const colorName = (c) => c.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
function add(part, family, model, display, capacity, color, price) {
  PARTS[part] = { part, family, model, display, capacity, color, price, slug: `${display}-inch-display-${capacity}-${color}`, name: `${model} ${cap(capacity)} ${colorName(color)}` };
}
const DUO = { '256gb': ['MK244AH/A', 'MK254AH/A', 5299], '512gb': ['MK264AH/A', 'MK274AH/A', 6149], '1tb': ['MK284AH/A', 'MK294AH/A', 6999], '2tb': ['MK2A4AH/A', 'MK2C4AH/A', 8699] };
for (const [c, [w, s, p]] of Object.entries(DUO)) { add(w, 'iphone-duo', 'iPhone Duo', '7.6', c, 'star-white', p); add(s, 'iphone-duo', 'iPhone Duo', '7.6', c, 'night-sky', p); }
const PRO = [
  ['256gb', 'black', 'MJR54AH/A', 'MJX54AH/A'], ['256gb', 'silver', 'MJR64AH/A', 'MJX64AH/A'], ['256gb', 'burgundy', 'MJR74AH/A', 'MJX74AH/A'], ['256gb', 'glacier', 'MJR84AH/A', 'MJX84AH/A'],
  ['512gb', 'black', 'MJR94AH/A', 'MJX94AH/A'], ['512gb', 'silver', 'MJRC4AH/A', 'MJXA4AH/A'], ['512gb', 'burgundy', 'MJRD4AH/A', 'MJXC4AH/A'], ['512gb', 'glacier', 'MJRE4AH/A', 'MJXD4AH/A'],
  ['1tb', 'black', 'MJRF4AH/A', 'MJXE4AH/A'], ['1tb', 'silver', 'MJRG4AH/A', 'MJXF4AH/A'], ['1tb', 'burgundy', 'MJRH4AH/A', 'MJXG4AH/A'], ['1tb', 'glacier', 'MJRJ4AH/A', 'MJXH4AH/A'],
  ['2tb', 'black', 'MJRK4AH/A', 'MJXJ4AH/A'], ['2tb', 'silver', 'MJRL4AH/A', 'MJXK4AH/A'], ['2tb', 'burgundy', 'MJRM4AH/A', 'MJXL4AH/A'], ['2tb', 'glacier', 'MJRN4AH/A', 'MJXM4AH/A'],
];
for (const [c, col, pro, max] of PRO) { add(pro, 'iphone-18-pro', 'iPhone 18 Pro', '6.3', c, col, 4699); add(max, 'iphone-18-pro', 'iPhone 18 Pro Max', '6.9', c, col, 5099); }
const partBySlug = (family, slug) => Object.values(PARTS).find((p) => p.family === family && p.slug === slug.toLowerCase());
const isOpen = (p) => p.family !== 'iphone-duo' || Date.now() >= openAt;

const STORES = [
  { id: 'R597', name: 'Apple Dubai Mall', city: 'Dubai' },
  { id: 'R596', name: 'Apple Mall of the Emirates', city: 'Dubai' },
  { id: 'R706', name: 'Apple Al Maryah Island', city: 'Abu Dhabi' },
  { id: 'R595', name: 'Apple Yas Mall', city: 'Abu Dhabi' },
  { id: 'R785', name: 'Apple Al Jimi Mall', city: 'Al Ain' },
];
const CITIES = ['Abu Dhabi', 'Al Ain', 'Dubai', 'Sharjah'];

// ---------- сессии ----------
const sessions = new Map();
const orders = [];
function session(req, res) {
  const ck = cookies(req);
  let sid = ck.sid;
  if (!sid || !sessions.has(sid)) {
    sid = crypto.randomBytes(8).toString('hex');
    const addr = clientAddr(req);
    addrSessions.set(addr, (addrSessions.get(addr) ?? 0) + 1);
    sessions.set(sid, { sid, addr, created: Date.now(), hits: [], bag: [], busyShown: false, queueLeft: null, lastQueueUrl: null, queueReloads: 0, queuePassed: 0, fulfillErr: 0, contactErr: 0, atbAttempts: 0, atbDirect: 0, atb: crypto.randomBytes(20).toString('hex'), atbOk: 0, atb404: 0, checkout: {}, geo: null, pending: null, admitted: false, stubAt: 0, stubPoll: 0, stubLoads: 0, captchaPassed: false, captchaShown: 0 });
    res.appendHeader('set-cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
  }
  const s = sessions.get(sid);
  if (ck.geo) s.geo = ck.geo;
  return s;
}
function cookies(req) {
  const out = {};
  for (const p of (req.headers.cookie ?? '').split(';')) { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim(); }
  return out;
}
const aed = (n) => `AED ${n.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => r(b)); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- разметка ----------
const CSS = `body{font:15px/1.4 -apple-system,Helvetica,Arial,sans-serif;margin:0;color:#1d1d1f}main{max-width:900px;margin:0 auto;padding:20px}
#globalnav{background:#f5f5f7;padding:10px 20px;font-size:12px}#globalnav a{margin-right:16px;color:#1d1d1f}
.vh{position:absolute;opacity:0;width:1px;height:1px}label{display:inline-block;border:1px solid #d2d2d7;border-radius:10px;padding:10px 14px;margin:4px;cursor:pointer}
input:checked+label{border-color:#0071e3;box-shadow:0 0 0 1px #0071e3}input:disabled+label{opacity:.45}
button{font:inherit;padding:10px 18px;border-radius:10px;border:0;background:#0071e3;color:#fff;cursor:pointer}button:disabled{background:#d2d2d7;color:#86868b}
.rc-segmented-control-button{background:#fff;color:#1d1d1f;border:1px solid #d2d2d7}.rc-segmented-control-selected{border-color:#0071e3;box-shadow:0 0 0 1px #0071e3}
.rs-error{color:#d70015;min-height:1.2em}.ac-ls{background:#f5f5f7;border-bottom:1px solid #d2d2d7;padding:12px 20px}li{list-style:none}`;
function page(s, title, body, { status, scripts = '' } = {}) {
  const banner = S.countryPicker && s && s.geo !== 'AE' ? `
<aside id="ac-ls" class="ac-ls" role="region" aria-label="Choose your country or region"><div class="ac-ls-content">
<p class="ac-ls-copy">Choose another country or region to see content specific to your location and shop online.</p>
<select class="ac-ls-dropdown" aria-label="Choose your country or region"><option value="/us/">United States</option><option value="/uk/">United Kingdom</option><option value="/ae/?locale=ae">United Arab Emirates</option></select>
<a class="ac-ls-button ac-ls-continue" href="/us/">Continue</a> <button class="ac-ls-close" aria-label="Close">✕</button></div></aside>
<script>(function(){var a=document.getElementById('ac-ls');var s=a.querySelector('select');var c=a.querySelector('.ac-ls-continue');s.addEventListener('change',function(){c.href=s.value;});a.querySelector('.ac-ls-close').onclick=function(){a.remove();};})();</script>` : '';
  return { status: status ?? 200, html: `<!doctype html><html lang="en-AE"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style></head><body>
<nav id="globalnav"><a href="/ae/">Apple</a><a href="/ae/iphone/">iPhone</a><a href="/ae/shop/bag">Bag</a></nav>${banner}
<main id="main">${body}</main>${scripts}</body></html>` };
}
const notFound = (s) => page(s, 'Page Not Found - Apple (AE)', '<h1>The page you’re looking for can’t be found.</h1><p>Page Not Found</p>', { status: 404 });
const busy = (s) => page(s, 'Apple Store', '<h1>We’re busy right now.</h1><p>Almost there — so are we. Please try again in a moment.</p>', { status: 503 });
// текст снят с apple.com (US) перед предзаказом iPhone 17/18 Pro
const backSoon = (s, status = 503) => page(s, 'Apple Store', '<h1>We love that early energy.</h1><p>Almost ready for you. Pre-order begins at 4:00 p.m. See you soon.</p>', { status });
// страница очереди: сама ведёт дальше через meta refresh (как «очередь» Apple 12.09.2026)
const queuePage = (s, nextUrl, step) => page(s, 'Apple Store', `<h1>You’re in line.</h1><p>We’ll take you to the store when it’s your turn (step ${step}). Please don’t refresh this page.</p>`
  + `<meta http-equiv="refresh" content="2;url=${nextUrl}">`);
const storeOpen = () => Date.now() >= openAt;
// ADMIT_MODE: заглушка перед стартом/после (гипотеза 1). queue — сама пускает (опрос), refresh — только перезагрузка после открытия
const admitStub = (s) => page(s, 'Apple Store', '<h1>We love that early energy.</h1><p>Almost ready for you. Pre-order begins at 4:00 p.m. See you soon.</p>',
  { scripts: S.admitMode === 'queue' ? `<script>setInterval(function(){fetch('/__admit',{credentials:'include'}).then(function(r){return r.json();}).then(function(j){if(j.admitted)location.reload();});},1000);</script>` : '' });
const blocked = (req) => ({ status: 403, html: `<!doctype html><html><head><title>Access Denied</title></head><body><h1>Access Denied</h1>You don't have permission to access "http&#58;&#47;&#47;${esc(req.headers.host)}${esc(req.url)}" on this server.<p>Reference&#32;&#35;18&#46;${crypto.randomBytes(4).toString('hex')}</p></body></html>` });
const captchaPage = (s, what) => page(s, 'Apple - Verify', `<div id="captcha" role="dialog" style="padding:30px;border:1px solid #d2d2d7;border-radius:12px;max-width:420px"><h2>Verify you are human</h2><p>Complete the security challenge to continue to the ${esc(what)}.</p><label id="captcha-label" style="display:block;padding:12px;border:1px solid #d2d2d7"><input type="checkbox" id="captcha-check"> I'm not a robot</label></div>`,
  { scripts: `<script>document.getElementById('captcha-check').addEventListener('click',function(e){if(!e.isTrusted){e.preventDefault();return;}fetch('/__captcha/pass',{method:'POST',credentials:'include'}).then(function(){location.reload();});});</script>` });

function productPage(s, p) {
  const open = isOpen(p);
  const boot = { part: p.part, family: p.family, node: `home/shop_iphone/family/${p.family.replace(/-/g, '_')}`, hydrateMs: S.hydrateMs, open };
  const colors = Object.values(PARTS).filter((x) => x.family === p.family && x.model === p.model && x.capacity === p.capacity);
  const caps = Object.values(PARTS).filter((x) => x.family === p.family && x.model === p.model && x.color === p.color);
  const body = `<h1>Buy ${esc(p.model)}</h1>
<p class="price">From ${aed(p.price)}</p>
${open ? '' : '<p class="rf-preorder">Pre-order starting at 4:00 p.m. local time on 16/10. Available starting 23/10.</p>'}
<fieldset><legend>Finish</legend>${colors.map((x) => `<input class="vh" type="radio" name="dimensionColor" id="c-${x.color}" data-autom="dimensionColor${x.color.replace(/-/g, '')}" ${x.part === p.part ? 'checked' : ''} onchange="location.href='/ae/shop/buy-iphone/${x.family}/${x.slug}'"><label for="c-${x.color}">${colorName(x.color)}</label>`).join('')}</fieldset>
<fieldset><legend>Storage</legend>${caps.map((x) => `<input class="vh" type="radio" name="dimensionCapacity" id="k-${x.capacity}" data-autom="dimensionCapacity${x.capacity}" ${x.part === p.part ? 'checked' : ''} onchange="location.href='/ae/shop/buy-iphone/${x.family}/${x.slug}'"><label for="k-${x.capacity}">${cap(x.capacity)}</label>`).join('')}</fieldset>
<div id="app"><p>Loading…</p></div>
<script id="boot" type="application/json">${JSON.stringify(boot)}</script>`;
  return page(s, `Buy ${p.model} - Apple (AE)`, body, { scripts: `<script>(${productClient.toString()})(${JSON.stringify(p.name)}, ${JSON.stringify(aed(p.price))});</script>` });
}

// клиент конфигурации (выполняется в браузере)
function productClient(name, price) {
  var B = JSON.parse(document.getElementById('boot').textContent);
  var app = document.getElementById('app');
  function cookie(n) { var m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)')); return m ? m[1] : ''; }
  setTimeout(function () {
    if (!B.open) {
      app.innerHTML = '<h2 data-autom="summary-productName">' + name + '</h2><button type="button" data-autom="continueButton" disabled>Continue</button>';
      return;
    }
    app.innerHTML = '<h2 data-autom="summary-productName">' + name + ' — ' + price + '</h2>'
      + '<fieldset><legend>Do you have a smartphone to trade in?</legend>'
      + '<input class="vh" type="radio" id="ti-no" name="tradein" value="noTradeIn"><label for="ti-no" data-autom="choose-noTradeIn">No trade-in</label>'
      + '<input class="vh" type="radio" id="ti-yes" name="tradein" value="tradeIn"><label for="ti-yes" data-autom="choose-tradeIn">Select a smartphone</label></fieldset>'
      + '<fieldset><legend>AppleCare+ coverage</legend>'
      + '<input class="vh" type="radio" id="ac-no" name="applecare" value="none" data-autom="noapplecare"><label for="ac-no">No AppleCare+ coverage</label>'
      + '<input class="vh" type="radio" id="ac-yes" name="applecare" value="AC" data-autom="applecare"><label for="ac-yes">AppleCare+</label></fieldset>'
      + '<form id="atb" method="GET" action="#"><input type="hidden" name="product" value="' + B.part + '"><input type="hidden" name="purchaseOption" value="fullPrice"><input type="hidden" name="step" value="select"><input type="hidden" name="hx" value="">'
      + '<button type="submit" name="add-to-cart" value="add-to-cart" data-autom="add-to-cart" disabled>Add to Bag</button></form>';
    var trade = false, acpart = null, btn = app.querySelector('[data-autom="add-to-cart"]'), form = document.getElementById('atb');
    function upd() { btn.disabled = !(trade && acpart); }
    function summary(extra) { return fetch('/ae/shop/updateSummary?fae=true&node=' + B.node + '&step=select&product=' + B.part + extra + '&igt=true', { credentials: 'include' }); }
    app.querySelectorAll('input[name=tradein]').forEach(function (i) { i.addEventListener('change', function () { summary('').then(function () { trade = true; upd(); }); }); });
    app.querySelectorAll('input[name=applecare]').forEach(function (i) { i.addEventListener('change', function () { var v = i.value === 'none' ? 'none' : 'AC1'; summary('&acpart=' + v).then(function () { acpart = v; upd(); }); }); });
    btn.addEventListener('pointerdown', function () { form.hx.value = '1'; });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var url = location.pathname + '?product=' + B.part + '&purchaseOption=fullPrice&step=select&acpart=' + (acpart === 'none' ? 'none' : '')
        + '&atbtoken=' + cookie('as_atb') + '&igt=true' + (form.hx.value ? '&hx=1' : '') + '&fs=1&add-to-cart=add-to-cart';
      location.assign(url);
    });
  }, B.hydrateMs);
}

function atbPendingPage(s, p, token) {
  const js = `<script>setTimeout(function(){fetch('/ae/shop/beacon/atb?product=${encodeURIComponent(p.part)}&t=${token}',{method:'POST',credentials:'include'}).then(function(){fetch('/ae/shop/dc',{credentials:'include'});location.replace('/ae/shop/buy-iphone/${p.family}?product=${p.part.toLowerCase()}&step=attach');});},${S.attachDelayMs});</script>`;
  return page(s, `Buy ${p.model} - Apple (AE)`, `<h1>Buy ${esc(p.model)}</h1><div data-autom="summary-productName">${esc(p.name)}</div><p>Adding to your bag…</p>`, { scripts: js });
}

function attachPage(s, p) {
  return page(s, 'Add accessories - Apple (AE)', `<h1>Add accessories to your new ${esc(p?.model ?? 'iPhone')}.</h1>
<p data-autom="attach-summary">${esc(p?.name ?? '')} added to your bag.</p><a href="/ae/shop/bag" data-autom="proceed">Review Bag</a>`);
}

function bagJson(s) {
  return { items: s.bag.map((i) => ({ id: i.id, name: PARTS[i.part].name, qty: i.qty, price: aed(PARTS[i.part].price * i.qty) })), total: aed(s.bag.reduce((a, i) => a + PARTS[i.part].price * i.qty, 0)) };
}

function bagPage(s) {
  return page(s, 'Bag - Apple (AE)', `<h1 id="bag-title"></h1><ol id="items"></ol><div id="summary"></div>
<script id="bag" type="application/json">${JSON.stringify(bagJson(s))}</script>`, { scripts: `<script>(${bagClient.toString()})();</script>` });
}

function bagClient() {
  var data = JSON.parse(document.getElementById('bag').textContent);
  function post(url) { return fetch(url, { method: 'POST', credentials: 'include' }).then(function (r) { return r.json(); }); }
  function render() {
    var items = document.getElementById('items'), sum = document.getElementById('summary');
    document.getElementById('bag-title').textContent = data.items.length ? 'Review your bag.' : 'Your bag is empty.';
    items.innerHTML = data.items.map(function (i) {
      return '<li class="rs-iteminfo" data-id="' + i.id + '"><h2 data-autom="bag-item-name"><a href="#">' + i.name + '</a></h2>'
        + '<select data-autom="item-quantity-dropdown" aria-label="Quantity">' + [1, 2, 3].map(function (q) { return '<option' + (q === i.qty ? ' selected' : '') + '>' + q + '</option>'; }).join('') + '</select>'
        + ' <span>' + i.price + '</span> <button type="button" data-autom="bag-item-remove-button">Remove</button></li>';
    }).join('');
    sum.innerHTML = data.items.length ? '<p>Total <span data-autom="bagtotalvalue">' + data.total + '</span></p>'
      + (data.items.some(function (i) { return i.qty > 2; }) ? '<p>You can buy a maximum of 2 per customer.</p>' : '')
      + '<button type="button" data-autom="checkout">Check Out</button> <button type="button" data-autom="checkout-with-apple-pay">Check out with Apple Pay</button>' : '';
    items.querySelectorAll('li').forEach(function (li) {
      li.querySelector('[data-autom=bag-item-remove-button]').onclick = function () { post('/ae/shop/bag/remove?id=' + li.dataset.id).then(function (d) { setTimeout(function () { data = d; render(); }, 200); }); };
      li.querySelector('select').addEventListener('change', function (e) { post('/ae/shop/bag/qty?id=' + li.dataset.id + '&qty=' + e.target.value).then(function (d) { data = d; render(); }); });
    });
    var co = sum.querySelector('[data-autom=checkout]');
    if (co) co.onclick = function () { setTimeout(function () { location.assign('/ae/shop/signIn?ssi=1AAABm' + Math.random().toString(36).slice(2)); }, 150); };
  }
  render();
}

function signInPage(s) {
  const init = { meta: { h: { 'x-aos-stk': crypto.randomBytes(16).toString('hex'), 'x-aos-model-page': 'signInPage', modelVersion: 'v2', syntax: 'graviton' } } };
  return page(s, 'Sign In - Apple (AE)', `<h1>Ready to check out?</h1>
<section><h2>Sign in with Apple ID</h2><input placeholder="Apple ID" aria-label="Apple ID"> <input type="password" aria-label="Password"></section>
<section><h2>Guest Checkout</h2><button type="button" data-autom="guest-checkout-btn" id="guest">Continue as Guest</button></section>
<script id="init_data" type="application/json">${JSON.stringify(init)}</script>`,
  { scripts: `<script>document.getElementById('guest').onclick=function(){setTimeout(function(){location.assign('/ae/shop/checkout?_s=Fulfillment-init');},250);};</script>` });
}

function slotsFor(dateIdx, day) {
  const out = [];
  for (let m = 16 * 60 + 15; m < 20 * 60; m += 15) {
    const f = (x) => `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
    const lab = (x) => { const h = Math.floor(x / 60); return `${((h + 11) % 12) + 1}:${String(x % 60).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; };
    out.push({ value: `${day}-${f(m)}-${f(m + 15)}`, label: `${lab(m)} – ${lab(m + 15)}` });
  }
  return out;
}

function checkoutPage(s) {
  const now = new Date();
  const dates = [0, 1, 2].map((i) => {
    const d = new Date(now.getTime() + i * 86400000);
    return { day: String(d.getDate()), label: d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }), iso: d.toISOString().slice(0, 10) };
  });
  const boot = {
    stores: STORES.map((x, i) => ({ ...x, available: !S.unavailableStores.includes(x.id), dist: (2.1 + i * 7.3).toFixed(1) })),
    cities: CITIES, defaultCity: S.defaultCity, dates, slots: Object.fromEntries(dates.map((d, i) => [d.day, slotsFor(i, d.day)])),
    items: bagJson(s).items, cardDelayMs: S.cardDelayMs, threeDsMs: S.threeDsMs,
    hangStores: S.hangStores, applePayTrustedOnly: S.applePayTrustedOnly, applePayQrExpireMs: S.applePayQrExpireMs,
  };
  return page(s, 'Checkout - Apple (AE)', `<div id="app"></div><script id="boot" type="application/json">${JSON.stringify(boot)}</script>`, { scripts: `<script>(${checkoutClient.toString()})();</script>` });
}

// одностраничный чекаут на history.pushState (как у Apple)
function checkoutClient() {
  var B = JSON.parse(document.getElementById('boot').textContent);
  var app = document.getElementById('app');
  var st = { mode: 'delivery', city: B.defaultCity, store: null, day: null, slot: '', removed: {}, who: null, contact: {}, ship: {}, method: null, card: {}, bill: {} };
  function step() { return (new URLSearchParams(location.search).get('_s') || 'Fulfillment-init'); }
  function go(s) { history.pushState({}, '', '/ae/shop/checkout?_s=' + s); render(); }
  window.addEventListener('popstate', render);
  function post(url, body) {
    return fetch(url, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() })
      .then(function (r) { return r.json(); });
  }
  function el(html) { var d = document.createElement('div'); d.innerHTML = html; return d; }
  function setErr(t) { var e = document.getElementById('err'); if (e) e.textContent = t || ''; }
  function bindField(root, key, obj) {
    root.querySelectorAll('input[name]').forEach(function (i) { i.addEventListener('input', function () { obj[i.name] = i.value; }); });
    root.querySelectorAll('select[name]').forEach(function (s) { s.addEventListener('change', function () { obj[s.name] = s.value; }); });
  }

  function render() {
    var s = step().replace(/-init$/, '');
    app.innerHTML = '';
    if (s === 'Fulfillment') return fulfillment();
    if (s === 'Shipping') return shipping();
    if (s === 'PickupContact') return pickupContact();
    if (s === 'Billing') return billing();
    if (s === 'Review') return review();
    app.appendChild(el('<h1>Unknown step</h1>'));
  }

  // --- Fulfillment ---
  function fulfillment() {
    app.appendChild(el('<h1>Where would you like to get your order?</h1><p>' + B.items.map(function (i) { return i.name; }).join(', ') + '</p>'
      + '<div class="rc-segmented-control" role="radiogroup"><button type="button" class="rc-segmented-control-button" data-mode="delivery">I’d like it delivered</button>'
      + '<button type="button" class="rc-segmented-control-button" data-mode="pickup">I’ll pick it up</button></div>'
      + '<div id="pane"></div><div id="err" class="rs-error" role="alert"></div><button type="button" id="cont" data-autom="fulfillment-continue-button" disabled>Continue</button>'));
    app.querySelectorAll('.rc-segmented-control-button').forEach(function (b) {
      b.onclick = function () { st.mode = b.dataset.mode; setTimeout(pane, 150); segs(); };
    });
    document.getElementById('cont').onclick = cont;
    segs(); pane();
  }
  function segs() {
    app.querySelectorAll('.rc-segmented-control-button').forEach(function (b) { b.classList.toggle('rc-segmented-control-selected', b.dataset.mode === st.mode); });
    var c = document.getElementById('cont');
    c.textContent = st.mode === 'pickup' ? 'Continue to Pickup Details' : 'Continue to Shipping Address';
  }
  function pane() {
    var p = document.getElementById('pane');
    p.innerHTML = '';
    if (st.mode === 'delivery') {
      p.appendChild(el('<fieldset><legend>Delivery options</legend><input class="vh" type="radio" name="shipping-option" id="do1" data-autom="fulfillment-option-standard"><label for="do1">Standard — Free · Delivers Oct 23</label>'
        + '<input class="vh" type="radio" name="shipping-option" id="do2" data-autom="fulfillment-option-express"><label for="do2">Express — AED 25</label></fieldset>'));
      p.querySelectorAll('input').forEach(function (i) { i.addEventListener('change', function () { st.shipOpt = i.id; enable(); }); });
      enable();
      return;
    }
    p.appendChild(el('<label>City <select data-autom="form-field-city">' + B.cities.map(function (c) { return '<option' + (c === st.city ? ' selected' : '') + '>' + c + '</option>'; }).join('') + '</select></label>'
      + '<ul id="stores"></ul><div id="dates"></div><div id="slots"></div>'));
    p.querySelector('select').addEventListener('change', function (e) { st.city = e.target.value; st.store = null; st.day = null; st.slot = ''; document.getElementById('stores').innerHTML = '<li>Searching…</li>'; document.getElementById('dates').innerHTML = ''; document.getElementById('slots').innerHTML = ''; enable(); setTimeout(stores, 400); });
    stores();
  }
  function stores() {
    var ul = document.getElementById('stores');
    if (!ul) return;
    if (B.hangStores) {
      // HANG_STORES: «ищем магазины» до снятия флага на сервере (зависание для сторожа)
      ul.innerHTML = '<li>Searching for stores…</li>';
      fetch('/ae/shop/checkoutx/storesStatus', { credentials: 'include' }).then(function (r) { return r.json(); }).then(function (j) { if (j.hang) setTimeout(stores, 1000); else { B.hangStores = false; stores(); } });
      return;
    }
    var list = B.stores.slice().sort(function (a, b) { return (a.city === st.city ? 0 : 1) - (b.city === st.city ? 0 : 1); });
    ul.innerHTML = list.map(function (x) {
      return '<li data-autom="rt-storelocator-searchresult"><input class="vh" type="radio" name="store-locator-result" id="s-' + x.id + '" value="' + x.id + '"' + (x.available ? '' : ' disabled') + (st.store === x.id ? ' checked' : '') + '>'
        + '<label for="s-' + x.id + '"><b>' + x.name + '</b> · ' + x.dist + ' km · <span>' + (x.available ? 'Available Today' : 'Currently unavailable') + '</span></label></li>';
    }).join('');
    ul.querySelectorAll('input').forEach(function (i) {
      i.addEventListener('change', function () { st.store = i.value; st.day = null; st.slot = ''; setErr(''); document.getElementById('dates').innerHTML = ''; document.getElementById('slots').innerHTML = ''; enable(); setTimeout(dates, 250); });
    });
  }
  function dates() {
    var d = document.getElementById('dates');
    d.innerHTML = '<fieldset><legend>Pick a date</legend>' + B.dates.map(function (x) {
      return '<input class="vh" type="radio" name="bartPickupDateSelectorButtonGroup" id="d-' + x.day + '" value="' + x.day + '"' + (st.day === x.day ? ' checked' : '') + '><label for="d-' + x.day + '">' + x.label + '</label>';
    }).join('') + '</fieldset>';
    d.querySelectorAll('input').forEach(function (i) { i.addEventListener('change', function () { st.day = i.value; st.slot = ''; enable(); setTimeout(slots, 250); }); });
  }
  function slots() {
    var d = document.getElementById('slots');
    var opts = (B.slots[st.day] || []).filter(function (o) { return !st.removed[o.value]; });
    d.innerHTML = '<label>Check-in window <select data-autom="pickup-availablewindow-dropdown"><option value="">Select a time</option>'
      + opts.map(function (o) { return '<option value="' + o.value + '"' + (st.slot === o.value ? ' selected' : '') + '>' + o.label + '</option>'; }).join('') + '</select></label>';
    d.querySelector('select').addEventListener('change', function (e) { st.slot = e.target.value; enable(); });
  }
  function enable() {
    var c = document.getElementById('cont');
    if (c) c.disabled = st.mode === 'pickup' ? !(st.store && st.day && st.slot) : !st.shipOpt;
  }
  function cont() {
    var c = document.getElementById('cont');
    c.disabled = true;
    if (st.mode === 'delivery') { post('/ae/shop/checkoutx/fulfillment?_a=continueFromFulfillmentToShipping&_m=checkout.fulfillment', { 'checkout.fulfillment.fulfillmentOptions.selectFulfillmentLocation': 'HOME' }).then(function () { go('Shipping-init'); }); return; }
    var sl = st.slot.split('-');
    var date = B.dates.find(function (x) { return x.day === st.day; });
    post('/ae/shop/checkoutx/fulfillment?_a=continueFromFulfillmentToPickupContact&_m=checkout.fulfillment', {
      'checkout.fulfillment.fulfillmentOptions.selectFulfillmentLocation': 'RETAIL',
      'checkout.fulfillment.pickupTab.pickup.storeLocator.selectStore': st.store,
      'checkout.fulfillment.pickupTab.pickup.storeLocator.searchInput': st.city,
      'checkout.fulfillment.pickupTab.pickup.timeSlot.dateTimeSlots.date': date ? date.iso : '',
      'checkout.fulfillment.pickupTab.pickup.timeSlot.dateTimeSlots.timeSlotValue': st.slot,
      'checkout.fulfillment.pickupTab.pickup.timeSlot.dateTimeSlots.dayRadio': st.day,
      'checkout.fulfillment.pickupTab.pickup.timeSlot.dateTimeSlots.startTime': sl[1], 'checkout.fulfillment.pickupTab.pickup.timeSlot.dateTimeSlots.endTime': sl[2],
      'checkout.fulfillment.pickupTab.pickup.timeSlot.dateTimeSlots.timeZone': 'Asia/Dubai',
    }).then(function (r) {
      if (r.ok) return go('PickupContact-init');
      if (r.generic) { setErr(r.error); enable(); return; }
      st.removed[st.slot] = true; st.slot = ''; setErr(r.error); slots(); enable();
    });
  }

  // --- Shipping (фолбэк доставки) ---
  function shipping() {
    var f = ['firstName', 'lastName', 'street', 'street2', 'city', 'emailAddress', 'mobilePhone'];
    app.appendChild(el('<h1>Where should we send your order?</h1>' + f.map(function (n) { return '<p><input name="' + n + '" data-autom="form-field-' + n + '" placeholder="' + n + '"></p>'; }).join('')
      + '<div id="err" class="rs-error" role="alert"></div><button type="button" data-autom="shipping-continue-button" id="cont">Continue to Payment</button>'));
    bindField(app, 'ship', st.ship);
    document.getElementById('cont').onclick = function () {
      post('/ae/shop/checkoutx?_a=continueFromShippingToBilling&_m=checkout.shipping', st.ship).then(function (r) { if (r.ok) go('Billing-init'); else setErr(r.error); });
    };
  }

  // --- PickupContact ---
  function pickupContact() {
    app.appendChild(el('<h1>Who will pick up your order?</h1>'
      + '<input class="vh" type="radio" name="pickupWho" id="pw-self" value="SELF" data-autom="selfPickup"><label for="pw-self">I’ll pick it up</label>'
      + '<input class="vh" type="radio" name="pickupWho" id="pw-3p" value="THIRD" data-autom="thirdPartyPickup"><label for="pw-3p">Someone else will pick it up</label>'
      + '<div id="fields"></div><div id="err" class="rs-error" role="alert"></div><button type="button" id="cont"><span data-autom="continue-button-label">Continue to Payment</span></button>'));
    app.querySelectorAll('input[name=pickupWho]').forEach(function (i) {
      i.addEventListener('change', function () {
        st.who = i.value;
        var f = document.getElementById('fields');
        f.innerHTML = '<div data-autom="form-field-firstName"><label>First Name <input name="firstName" autocomplete="given-name"></label></div>'
          + '<p><input name="lastName" data-autom="form-field-lastName" placeholder="Last Name"></p>'
          + '<div data-autom="form-field-emailAddress"><label>Email <input name="emailAddress" type="email"></label></div>'
          + '<p><input name="mobilePhone" data-autom="form-field-mobilePhone" placeholder="Mobile Number"></p>';
        bindField(f, 'contact', st.contact);
      });
    });
    document.getElementById('cont').onclick = function () {
      post('/ae/shop/checkoutx?_a=continueFromPickupContactToBilling&_m=checkout.pickupContact', {
        'checkout.pickupContact.pickupContactOptions.selectedPickupOption': st.who || '',
        'checkout.pickupContact.selfPickupContact.selfContact.address.firstName': st.contact.firstName || '',
        'checkout.pickupContact.selfPickupContact.selfContact.address.lastName': st.contact.lastName || '',
        'checkout.pickupContact.selfPickupContact.selfContact.address.emailAddress': st.contact.emailAddress || '',
        'checkout.pickupContact.selfPickupContact.selfContact.address.mobilePhone': st.contact.mobilePhone || '',
      }).then(function (r) { if (r.ok) go('Billing-init'); else setErr(r.error); });
    };
  }

  // --- Billing: граница автоматизации ---
  function billing() {
    var mountSeq = 0;
    app.appendChild(el('<h1>How do you want to pay?</h1>'
      + '<input class="vh" type="radio" name="billingOptions" id="bo-c" value="CREDIT" data-autom="checkout-billingOptions-CREDIT"><label for="bo-c">Credit or Debit Card</label>'
      + '<input class="vh" type="radio" name="billingOptions" id="bo-a" value="APPLE_PAY" data-autom="checkout-billingOptions-APPLE_PAY"><label for="bo-a">Apple Pay</label>'
      + '<div id="card"></div><p><input data-autom="form-field-taxRegNumber" placeholder="TRN (optional)"></p>'
      + '<div id="err" class="rs-error" role="alert"></div><button type="button" data-autom="continue-button-review" id="cont">Review Your Order</button>'));
    app.querySelectorAll('input[name=billingOptions]').forEach(function (i) {
      i.addEventListener('change', function () {
        st.method = i.value;
        post('/ae/shop/checkoutx/billing?_a=selectBillingOption', { method: i.value });
        var c = document.getElementById('card');
        // как на живом Billing 18 Pro (30.09): карта + Billing Address (Title, First/Last Name, Street, Area, Town (optional), City) — обязательны, кроме Title/Town
        var addr = '<h3>Billing Address</h3><div class="bill"><p><select name="title" data-autom="form-field-title"><option value="">Title</option><option>Mr.</option><option>Ms.</option></select></p>'
          + '<p><input name="firstName" data-autom="form-field-firstName" placeholder="First Name"> <input name="lastName" data-autom="form-field-lastName" placeholder="Last Name"></p>'
          + '<p><input name="street" data-autom="form-field-street" placeholder="Street Address"></p><p><input name="street2" data-autom="form-field-street2" placeholder="Area"></p><p><input name="street3" data-autom="form-field-street3" placeholder="Town (optional)"></p>'
          + '<p><select name="city" data-autom="form-field-city"><option value="">City</option><option>Abu Dhabi</option><option>Dubai</option><option>Sharjah</option></select></p></div>';
        var html = i.value === 'CREDIT' ? '<p><input name="cardNumber" data-autom="card-number-input" autocomplete="cc-number" placeholder="Card Number"></p><p><input name="exp" data-autom="expiration-input" autocomplete="cc-exp" placeholder="MM/YY"> <input name="cvv" data-autom="security-code-input" autocomplete="cc-csc" placeholder="CVV"></p>' + addr : '<p>You’ll confirm with Apple Pay after reviewing your order.</p>';
        st.bill = {};
        var seq = ++mountSeq;
        var mount = function () { if (seq !== mountSeq) return; c.innerHTML = html; bindField(c, 'card', st.card); var bl = c.querySelector('.bill'); if (bl) bindField(bl, 'bill', st.bill); };
        // CARD_DELAY_MS: блок карты подгружается с задержкой (Apple 30.09) — до этого только «Loading…»
        if (i.value === 'CREDIT' && B.cardDelayMs > 0) { c.innerHTML = '<p class="loading">Loading payment form…</p>'; setTimeout(mount, B.cardDelayMs); } else mount();
      });
    });
    document.getElementById('cont').onclick = function () {
      if (!st.method) return setErr('Please select a payment method.');
      if (st.method === 'CREDIT' && !/^\d{12,19}$/.test((st.card.cardNumber || '').replace(/\s/g, ''))) return setErr('Please enter a valid card number.');
      if (st.method === 'CREDIT' && !(st.bill.firstName && st.bill.lastName && st.bill.street && st.bill.street2 && st.bill.city)) return setErr('Please complete this mandatory field.');
      post('/ae/shop/checkoutx?_a=continueFromBillingToReview&_m=checkout.billing', { method: st.method, cardEntered: st.card.cardNumber ? '1' : '', cardLast4: (st.card.cardNumber || '').replace(/\D/g, '').slice(-4), exp: st.card.exp || '', cvvLen: String((st.card.cvv || '').length), nameOnCard: st.card.nameOnCard || '', billFirst: st.bill.firstName || '', billLast: st.bill.lastName || '', billStreet: st.bill.street || '', billArea: st.bill.street2 || '', billTown: st.bill.street3 || '', billCity: st.bill.city || '', billTitle: st.bill.title || '' }).then(function () { go('Review'); });
    };
  }

  function review() {
    var payInfo = st.method === 'APPLE_PAY' ? 'Apple Pay' : 'Card ending in ' + String(st.card.cardNumber || '').replace(/\D/g, '').slice(-4);
    app.appendChild(el('<section class="pay-summary"><h3>Payment</h3><p>' + payInfo + '</p><button type="button" data-autom="review-edit-payment">Edit</button></section>'));
    app.querySelector('[data-autom=review-edit-payment]').onclick = function () { go('Billing'); };
    // как на живом Review 18 Pro: галочка условий (input спрятан), без неё любая оплата даёт ошибку; Apple Pay — «Continue with [логотип] Pay»
    var pay = st.method === 'APPLE_PAY'
      ? '<button type="button" id="applepay" class="applepay-button" data-autom="apple-pay-button" aria-label="Continue with Apple Pay">Continue with <img alt="" width="14" height="14" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">Pay</button>'
        + '<div id="applepay-sheet" class="apple-pay-modal" role="dialog" aria-label="Apple Pay" hidden style="padding:20px;border:1px solid #000;border-radius:12px;width:260px"><p>Scan the code with your iPhone to pay with Apple Pay.</p><div style="width:120px;height:120px;background:#000" aria-label="QR code"></div>'
        + '<button type="button" data-test="applepay-confirm">[test] iPhone confirmed</button> <button type="button" data-test="applepay-cancel">Cancel</button></div>'
      : '<button type="button" id="place" data-autom="continue-button-placeorder">Place Order</button>';
    var terms = '<div class="terms"><input class="vh" type="checkbox" id="terms" name="terms"><label for="terms">I have read, understand, and agree to the <a href="#">Terms and Conditions</a> of Sale, and the Privacy Policy.</label></div><div id="err" class="rs-error" role="alert"></div>';
    app.appendChild(el('<h1>Review your order.</h1><p>' + B.items.map(function (i) { return i.name + ' · ' + i.price; }).join('<br>') + '</p>' + terms + pay));
    var tb = document.getElementById('terms');
    tb.onchange = function () { if (tb.checked) { document.getElementById('err').textContent = ''; post('/ae/shop/checkoutx?_a=termsAccepted', {}); } };
    function termsOk() {
      if (tb.checked) return true;
      document.getElementById('err').textContent = 'Please read and accept the terms & conditions of this order.';
      return false;
    }
    var ap = document.getElementById('applepay');
    var sheet = document.getElementById('applepay-sheet');
    var expireT = null;
    if (ap) ap.onclick = function (e) {
      if (!termsOk()) return;
      post('/ae/shop/checkoutx?_a=applePaySheet', { trusted: e.isTrusted ? '1' : '0' });
      // APPLEPAY_TRUSTED_ONLY: как лист Apple Pay в браузере — только от настоящего жеста пользователя
      if (B.applePayTrustedOnly && !e.isTrusted) return;
      sheet.hidden = false;
      clearTimeout(expireT);
      if (B.applePayQrExpireMs > 0) expireT = setTimeout(function () { sheet.hidden = true; post('/ae/shop/checkoutx?_a=applePayExpired', {}); }, B.applePayQrExpireMs);
    };
    if (sheet) {
      sheet.querySelector('[data-test=applepay-confirm]').onclick = function () {
        clearTimeout(expireT);
        post('/ae/shop/checkoutx?_a=applePayConfirm', {}).then(function (r) { location.assign('/ae/shop/checkout/thankyou?o=' + r.orderNo); });
      };
      sheet.querySelector('[data-test=applepay-cancel]').onclick = function () { clearTimeout(expireT); sheet.hidden = true; };
    }
    var place = document.getElementById('place');
    if (place) place.onclick = function () {
      if (!termsOk()) return;
      place.disabled = true;
      post('/ae/shop/checkoutx?_a=placeOrder&_m=checkout.review', {}).then(function (r) {
        // DECLINE_LAST4 / PLACE_GENERIC_ERR: остаёмся на Review с ошибкой, кнопка снова активна (бот не должен жать второй раз)
        if (!r.ok) { document.getElementById('err').textContent = r.error; place.disabled = false; return; }
        var go = function () { location.assign('/ae/shop/checkout/thankyou?o=' + r.orderNo); };
        // THREEDS_MS: «подтверди в приложении банка» — как 3-D Secure у банка (в жизни — iframe/редирект банка)
        if (B.threeDsMs > 0) { app.appendChild(el('<div id="threeds" role="dialog"><h2>Confirm the payment in your bank app</h2><p>Waiting for your bank…</p></div>')); setTimeout(go, B.threeDsMs); } else go();
      });
    };
  }

  render();
}

function thankYouPage(s, no) {
  return page(s, 'Thank You - Apple (AE)', `<h1>Thank you for your order.</h1><p>Your order number is <b>${esc(no)}</b>. We’ll send you a confirmation email.</p>`);
}

// ---------- JSON ----------
function fulfillmentMessages(q) {
  const parts = [0, 1, 2].map((i) => q.get(`parts.${i}`)).filter(Boolean).map((p) => p.toUpperCase());
  const deliveryMessage = {};
  for (const p of parts) {
    const part = PARTS[p];
    if (!part) continue;
    const open = isOpen(part);
    const buy = open ? { isBuyable: true, reason: null, commitCode: '0' } : { isBuyable: false, reason: 'COMING_SOON', commitCode: '9942' };
    deliveryMessage[p] = { regular: { buyability: buy, quote: open ? 'Delivers Oct 23' : '' }, compact: { buyability: buy, quote: open ? 'Delivers Oct 23' : '' } };
  }
  const stores = STORES.map((st) => ({
    storeNumber: st.id, storeName: st.name.replace(/^Apple /, ''),
    partsAvailability: Object.fromEntries(parts.map((p) => {
      const open = PARTS[p] ? isOpen(PARTS[p]) : false;
      const av = open && !S.unavailableStores.includes(st.id);
      return [p, { pickupDisplay: !open ? 'ineligible' : av ? 'available' : 'unavailable', pickupSearchQuote: !open ? 'Currently unavailable' : av ? 'Available Today' : 'Currently unavailable' }];
    })),
  }));
  return { head: { status: '200' }, body: { content: { deliveryMessage, pickupMessage: { stores } } } };
}

// ---------- роутер ----------
function send(res, r) {
  res.writeHead(r.status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  // и разметка, и клиентские скрипты мока переименовываются согласованно — ломается только расширение
  res.end(S.renameAutom ? r.html.replace(/data-autom/g, 'data-qa') : r.html);
}
function json(res, obj, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const q = url.searchParams;
  const path = url.pathname;
  try {
    // служебное
    if (path === '/__state') {
      return json(res, {
        open: Date.now() >= openAt, openAt, settings: S,
        sessions: [...sessions.values()].map((s) => ({
          sid: s.sid, geo: s.geo, bag: s.bag.map((i) => ({ part: i.part, qty: i.qty })), atbOk: s.atbOk, atb404: s.atb404,
          checkout: s.checkout, busyShown: s.busyShown, hits: s.hits, queueReloads: s.queueReloads, queuePassed: s.queuePassed, atbAttempts: s.atbAttempts,
          addr: s.addr, admitted: s.admitted, stubLoads: s.stubLoads, atbDirect: s.atbDirect, captchaShown: s.captchaShown, captchaPassed: s.captchaPassed,
        })),
        orders, placeLog, addrSessions: Object.fromEntries(addrSessions),
      });
    }
    if (path === '/__reset' && req.method === 'POST') { sessions.clear(); orders.length = 0; placeLog.length = 0; addrSessions.clear(); return json(res, { ok: true }); }
    if (path === '/__addr_sessions' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)) || '{}');
      addrSessions.set(String(b.addr), (addrSessions.get(String(b.addr)) ?? 0) + Number(b.n ?? 1));
      return json(res, { ok: true, count: addrSessions.get(String(b.addr)) });
    }
    // BLOCK_AFTER_SESSIONS: адрес клиента с числом сессий больше N — 403 на всё
    if (S.blockAfterSessions > 0 && (addrSessions.get(clientAddr(req)) ?? 0) > S.blockAfterSessions && !path.startsWith('/__')) {
      res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(blocked(req).html);
    }
    if (path === '/__config' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)) || '{}');
      Object.assign(S, b);
      if ('openAfter' in b) openAt = Date.now() + Number(b.openAfter) * 1000;
      return json(res, { ok: true, settings: S, openAt });
    }

    const s = session(req, res);
    if (S.blockAfterSessions > 0 && (addrSessions.get(clientAddr(req)) ?? 0) > S.blockAfterSessions) {
      res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(blocked(req).html);
    }
    if (path === '/__admit') { s.stubPoll = Date.now(); return json(res, { admitted: s.admitted }); }
    if (path === '/__captcha/pass' && req.method === 'POST') { s.captchaPassed = true; return json(res, { ok: true }); }
    const navigate = req.headers['sec-fetch-mode'] === 'navigate' || req.headers['sec-fetch-dest'] === 'document';
    const captchaHere = (what) => S.captchaAt === what && !s.captchaPassed && navigate;
    if (/^\/ae\/shop\/buy-iphone\/[^/]+\/[^/]+/.test(path) && !q.get('add-to-cart') && req.headers['sec-fetch-mode'] === 'navigate') s.hits.push(Date.now());
    if (q.get('locale') === 'ae') { s.geo = 'AE'; res.appendHeader('set-cookie', 'geo=AE; Path=/; SameSite=Lax'); }
    if (!req.headers.cookie?.includes('as_atb=')) res.appendHeader('set-cookie', `as_atb=${s.atb}; Path=/; SameSite=Lax`);

    // магазин закрыт перед дропом
    if (path === '/ae/shop/backsoon' || path === '/shop/backsoon') {
      if (storeOpen()) { res.writeHead(302, { location: '/ae/' }); return res.end(); }
      return send(res, backSoon(s, 200));
    }
    if (S.storeClosed && !storeOpen() && path.startsWith('/ae/shop/')) {
      const isJson = /fulfillment-messages|updateSummary|bag\/status/.test(path);
      if (S.storeClosed === 'blank') {
        if (isJson) { res.writeHead(503); return res.end(); }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end('<!doctype html><html><head><title></title></head><body></body></html>');
      }
      if (S.storeClosed === 'backsoon') return send(res, backSoon(s));
      res.writeHead(302, { location: S.storeClosed === 'offsite' ? '/shop/backsoon' : '/ae/shop/backsoon' });
      return res.end();
    }
    if (path === '/ae/shop/fulfillment-messages') return json(res, fulfillmentMessages(q));
    if (path === '/ae/shop/updateSummary') { await sleep(S.acpartDelayMs); return json(res, { head: { status: 200 }, body: { summary: { acpart: q.get('acpart') ?? null } } }); }
    if (path === '/ae/shop/updateSEO' || path === '/ae/shop/dc' || path === '/ae/shop/bag/status') return json(res, { ok: true, items: s.bag.length });
    if (path === '/ae/shop/beacon/atb') {
      const t = q.get('t');
      if (s.pending && s.pending.token === t) {
        if (!s.pending.ghost) {
          const ex = s.bag.find((i) => i.part === s.pending.part);
          if (ex) ex.qty++;
          else s.bag.push({ id: crypto.randomBytes(4).toString('hex'), part: s.pending.part, qty: 1 });
          s.atbOk++;
        }
        s.pending = null;
      }
      res.writeHead(204); return res.end();
    }
    if (path === '/ae/shop/bag/remove' && req.method === 'POST') { s.bag = s.bag.filter((i) => i.id !== q.get('id')); return json(res, bagJson(s)); }
    if (path === '/ae/shop/bag/qty' && req.method === 'POST') { const it = s.bag.find((i) => i.id === q.get('id')); if (it) it.qty = Number(q.get('qty')) || 1; return json(res, bagJson(s)); }
    if (path === '/ae/shop/bag') { if (captchaHere('bag')) { s.captchaShown++; return send(res, captchaPage(s, 'bag')); } return send(res, bagPage(s)); }
    if (/^\/ae\/shop\/signin$/i.test(path)) {
      if (!s.bag.length) { res.writeHead(302, { location: '/ae/shop/bag' }); return res.end(); }
      if (captchaHere('signin')) { s.captchaShown++; return send(res, captchaPage(s, 'sign in')); }
      return send(res, signInPage(s));
    }
    if (path === '/ae/shop/checkout/thankyou') return send(res, thankYouPage(s, q.get('o')));
    if (path === '/ae/shop/checkout') {
      if (!s.bag.length) { res.writeHead(302, { location: '/ae/shop/bag' }); return res.end(); }
      if (captchaHere('checkout')) { s.captchaShown++; return send(res, captchaPage(s, 'checkout')); }
      return send(res, checkoutPage(s));
    }
    if (path.startsWith('/ae/shop/checkoutx')) {
      const body = Object.fromEntries(new URLSearchParams(await readBody(req)));
      const a = q.get('_a');
      await sleep(150);
      if (a === 'continueFromFulfillmentToPickupContact') {
        const slot = body['checkout.fulfillment.pickupTab.pickup.timeSlot.dateTimeSlots.timeSlotValue'] ?? '';
        const store = body['checkout.fulfillment.pickupTab.pickup.storeLocator.selectStore'];
        if (S.unavailableStores.includes(store)) return json(res, { ok: false, error: 'This store is not available for pickup.' });
        if (S.checkoutErrFirst && s.fulfillErr++ === 0) return json(res, { ok: false, generic: true, error: 'We’re sorry, something went wrong. Please try again.' });
        const firstOfDay = /-16:15-16:30$/.test(slot);
        if (S.takenFirstSlot && firstOfDay) return json(res, { ok: false, error: 'The pickup time you selected is no longer available. Please choose another time.' });
        s.checkout.fulfillment = { store, slot, city: body['checkout.fulfillment.pickupTab.pickup.storeLocator.searchInput'] };
        return json(res, { ok: true });
      }
      if (a === 'continueFromFulfillmentToShipping') { s.checkout.fulfillment = { delivery: true }; return json(res, { ok: true }); }
      if (a === 'continueFromShippingToBilling') {
        if (!/^05\d{8}$/.test(body.mobilePhone ?? '')) return json(res, { ok: false, error: 'Please enter a valid mobile number.' });
        s.checkout.shipping = { city: body.city, area: !!body.street2 };
        return json(res, { ok: true });
      }
      if (a === 'continueFromPickupContactToBilling') {
        const pre = 'checkout.pickupContact.selfPickupContact.selfContact.address.';
        if (body['checkout.pickupContact.pickupContactOptions.selectedPickupOption'] !== 'SELF') return json(res, { ok: false, error: 'Please choose who will pick up the order.' });
        if (S.checkoutErrFirst && s.contactErr++ === 0) return json(res, { ok: false, generic: true, error: 'An unexpected error occurred. Please try again.' });
        if (!body[pre + 'firstName'] || !body[pre + 'lastName']) return json(res, { ok: false, error: 'Please enter a first and last name.' });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body[pre + 'emailAddress'] ?? '')) return json(res, { ok: false, error: 'Please enter a valid email address.' });
        if (!/^05\d{8}$/.test(body[pre + 'mobilePhone'] ?? '')) return json(res, { ok: false, error: 'Please enter a valid mobile number.' });
        s.checkout.contact = { first: body[pre + 'firstName'][0], ok: true };
        return json(res, { ok: true });
      }
      if (a === 'selectBillingOption') { s.checkout.method = body.method; return json(res, { ok: true }); }
      if (a === 'continueFromBillingToReview') { s.checkout.review = { method: body.method, cardEntered: !!body.cardEntered, cardLast4: body.cardLast4, exp: body.exp, cvvLen: Number(body.cvvLen), nameOnCard: body.nameOnCard, billing: body.method === 'CREDIT' ? { first: body.billFirst, last: body.billLast, street: body.billStreet, area: body.billArea, town: body.billTown, city: body.billCity, title: body.billTitle } : null }; return json(res, { ok: true }); }
      if (a === 'termsAccepted') { s.checkout.termsAccepted = true; return json(res, { ok: true }); }
      if (a === 'applePaySheet') {
        s.checkout.applePayClicks = (s.checkout.applePayClicks ?? 0) + 1;
        if (body.trusted === '1') s.checkout.applePayTrusted = (s.checkout.applePayTrusted ?? 0) + 1;
        if (body.trusted === '1' || !S.applePayTrustedOnly) s.checkout.applePaySheets = (s.checkout.applePaySheets ?? 0) + 1;
        return json(res, { ok: true });
      }
      if (a === 'applePayExpired') { s.checkout.applePayExpired = (s.checkout.applePayExpired ?? 0) + 1; return json(res, { ok: true }); }
      if (a === 'applePayConfirm') {
        const no = `W${String(100000000 + Math.floor(Math.random() * 899999999))}`;
        orders.push({ orderNo: no, sid: s.sid, items: s.bag.map((i) => ({ part: i.part, qty: i.qty })), checkout: s.checkout, method: 'APPLE_PAY', at: Date.now() });
        placeLog.push({ sid: s.sid, method: 'APPLE_PAY', result: 'ok', orderNo: no, at: Date.now() });
        s.bag = [];
        return json(res, { ok: true, orderNo: no });
      }
      if (a === 'placeOrder') {
        s.checkout.placeOrderClicks = (s.checkout.placeOrderClicks ?? 0) + 1;
        const last4 = s.checkout.review?.cardLast4 ?? '';
        if (S.declineLast4.includes(last4)) {
          placeLog.push({ sid: s.sid, last4, result: 'declined', at: Date.now() });
          return json(res, { ok: false, declined: true, error: 'Your payment was declined. Please use a different card or payment method.' });
        }
        if (S.placeGenericErr) {
          placeLog.push({ sid: s.sid, last4, result: 'generic', at: Date.now() });
          return json(res, { ok: false, generic: true, error: 'An unexpected error occurred. Please try again later.' });
        }
        const no = `W${String(100000000 + Math.floor(Math.random() * 899999999))}`;
        orders.push({ orderNo: no, sid: s.sid, items: s.bag.map((i) => ({ part: i.part, qty: i.qty })), checkout: s.checkout, method: 'CREDIT', cardLast4: last4, at: Date.now() });
        placeLog.push({ sid: s.sid, last4, result: 'ok', orderNo: no, at: Date.now() });
        s.bag = [];
        return json(res, { ok: true, orderNo: no });
      }
      if (a === 'storesStatus' || path.endsWith('/storesStatus')) return json(res, { hang: S.hangStores });
      return json(res, { ok: true });
    }
    let m = /^\/ae\/shop\/buy-iphone\/([^/]+)\/([^/]+)\/?$/.exec(path);
    if (m) {
      const p = partBySlug(m[1], m[2]);
      if (!p) return send(res, notFound(s));
      // живой сайт 04.10: 404 на адресе товара с хвостом ?product=…&step=…; в подвале — фраза, похожая на заглушку
      if (q.get('stale404') === '1') return send(res, page(s, 'Page Not Found - Apple (AE)', '<h1>The page you’re looking for can’t be found.</h1><footer><p>Some items or features may not be available right now in your country.</p><p>This item isn’t available right now.</p></footer>', { status: 404 }));
      if (q.get('add-to-cart') === 'add-to-cart') {
        const bad = q.get('acpart') !== 'none' || !q.get('atbtoken') || q.get('atbtoken') !== s.atb || (q.get('product') ?? '').toUpperCase() !== p.part
          || (S.requireTrusted && q.get('hx') !== '1') || !isOpen(p) || s.atb404 < S.atb404First || Math.random() < S.atb404Rate;
        if (bad) { s.atb404++; return send(res, notFound(s)); }
        const token = crypto.randomBytes(6).toString('hex');
        s.atbAttempts++;
        if (q.get('fs') !== '1') s.atbDirect++;
        // сломанная сессия корзины: attach проходит, товар не появляется
        s.pending = { part: p.part, token, ghost: S.emptyBagFirst && s.atbAttempts === 1 };
        return send(res, atbPendingPage(s, p, token));
      }
      if (S.admitMode && p.family === 'iphone-duo') {
        // гипотеза 1 (§7): refresh — пускаем тех, кто загрузил страницу после открытия; queue — пускает сама заглушка
        if (navigate) {
          if (S.admitMode === 'refresh' && storeOpen()) s.admitted = true;
          if (!s.admitted) { s.stubAt = Date.now(); s.stubLoads++; return send(res, admitStub(s)); }
        } else if (!s.admitted) return send(res, admitStub(s));
      }
      if (captchaHere('product') && isOpen(p)) { s.captchaShown++; return send(res, captchaPage(s, 'store')); }
      if (isOpen(p) && S.queueAfterOpen > 0) {
        const here = path + url.search;
        if (s.lastQueueUrl === here) { s.queueReloads++; return send(res, queuePage(s, `${path}?qstep=${s.queuePassed}`, s.queuePassed)); }
        if (s.queueLeft === null) s.queueLeft = S.queueAfterOpen;
        if (s.queueLeft > 0) {
          s.queueLeft--; s.queuePassed++;
          s.lastQueueUrl = here;
          return send(res, queuePage(s, `${path}?qstep=${s.queuePassed}`, s.queuePassed));
        }
        s.lastQueueUrl = null;
      }
      if (isOpen(p) && p.family === 'iphone-duo' && S.busyFirst && !s.busyShown) { s.busyShown = true; return send(res, busy(s)); }
      return send(res, productPage(s, p));
    }
    m = /^\/ae\/shop\/buy-iphone\/([^/]+)\/?$/.exec(path);
    if (m && q.get('step') === 'attach') return send(res, attachPage(s, PARTS[(q.get('product') ?? '').toUpperCase()]));
    if (path === '/ae/' || path === '/ae') return send(res, page(s, 'Apple (AE)', '<h1>iPhone Duo</h1><p>Pre-order starting 16/10.</p><a href="/ae/shop/buy-iphone/iphone-duo">Buy</a>'));
    if (/^\/(us|uk)\/?$/.test(path)) return send(res, page(null, 'Apple', `<h1>Apple ${path}</h1>`));
    return send(res, notFound(s));
  } catch (e) {
    console.error(e);
    res.writeHead(500); res.end(String(e));
  }
});

// ADMIT_MODE=queue: раз в ADMIT_EVERY_MS пускаем одну случайную сессию, которая ждёт на заглушке (опрашивает) не меньше ADMIT_MIN_WAIT_MS
setInterval(() => {
  if (S.admitMode !== 'queue' || !storeOpen()) return;
  const now = Date.now();
  const waiting = [...sessions.values()].filter((s) => !s.admitted && s.stubAt && now - s.stubPoll < 2500 && now - s.stubAt >= S.admitMinWaitMs);
  if (!waiting.length) return;
  const w = waiting[Math.floor(Math.random() * waiting.length)];
  w.admitted = true;
}, S.admitEveryMs).unref?.();

server.listen(S.port, '127.0.0.1', () => {
  console.log(`mock apple.com/ae → http://127.0.0.1:${S.port}  (Duo открывается через ${S.openAfter} с)`);
});
