# Apple Drop Assistant — Chrome-расширение для предзаказа iPhone Duo (apple.com/ae)

Версия 3 · 29.09.2026 · ТЗ для реализации (Codex / любой разработчик)

v1 и v2 были внешним ботом на Playwright. На живом сайте он не прошёл: пустая корзина, «Page Not Found» на Add to Bag, выбор страны в свежих профилях. v3 — **расширение для Chrome (Manifest V3)**. Оно работает в обычных профилях Chrome пользователя, внутри страниц Apple, без внешнего управления браузером (CDP/WebDriver).

Раздел 3 «Как устроен сайт» снят с живого apple.com/ae 28.09.2026: вручную пройден гостевой чекаут iPhone 18 Pro до экрана оплаты, записаны DOM и сетевые запросы. Непроверенные места помечены **[НЕ ПРОВЕРЕНО]**.

---

## 0. Цель и границы

**Цель.** 16.10.2026 в 16:00 по Дубаю открывается предзаказ iPhone Duo. Нужно быстро довести один или несколько заказов до экрана оплаты с забронированным слотом самовывоза в нужном магазине ОАЭ. Работа идёт в нескольких профилях и вкладках Chrome параллельно, оплату завершает человек.

**Расширение делает:**
- ловит открытие продаж;
- рефрешит страницы до активации;
- обрабатывает выбор страны;
- кладёт товар в корзину;
- проходит гостевой вход;
- выбирает самовывоз, магазин, дату и check-in window;
- заполняет контакты получателя;
- выбирает способ оплаты;
- выводит окно человеку по очереди, со звуком и уведомлением.

**Расширение НЕ делает** (обязательные ограничения, в код не добавлять):
- Не вводит номер карты, срок, CVV и не нажимает финальную кнопку заказа (Place Order / Pay). Финальное действие и авторизацию платежа (карта + Place Order или Apple Pay + Touch ID/iPhone) выполняет человек.
- Не обходит защиту Apple: без подмены отпечатков и User-Agent, без прокси-ротации, без решения капчи, без подделки токенов (`atbtoken`, `x-aos-stk`, Apple Shield), без `chrome.debugger` для «доверенных» кликов.
- Если Apple не принимает программные клики, включается **режим ассистента** (§7.8): критичную кнопку жмёт человек, остальное делает расширение.
- Не генерирует личности. Получатели — реальные люди: Apple выдаёт заказ по документу на имя из заказа и ограничивает количество на покупателя.
- Нагрузка — в разумных пределах (§7.2): не чаще одного рефреша вкладки в 1,5–2 с и не больше 8–12 окон с одного интернета.

---

## 1. Почему расширение

| Проблема v1/v2 | Что даёт расширение |
|---|---|
| Playwright запускает Chrome с флагами автоматизации (`--enable-automation`, CDP, `--no-sandbox`), свежий профиль без истории | Обычный Chrome пользователя, обычные профили с историей и cookie, без CDP |
| Свежий профиль → выбор страны, нет гео-cookie | Профили прогреваются заранее и живут постоянно |
| Уход со страницы Add to Bag раньше времени (баг v1) | Content script живёт в странице и видит её смену сам |
| Одно внешнее окно на заказ | Много вкладок в профиле плюс много профилей, координация через service worker и локальный хаб |

**Чего расширение не гарантирует.** Если Apple отличает программный `click()` (`event.isTrusted === false`) от настоящего и отклоняет Add to Bag, расширение не будет это маскировать. В таком случае Add to Bag жмёт человек в режиме ассистента (§7.8), а всё до и после делает расширение. Проверка — тест T3 в §11.2.

---

## 2. Контекст дропа

| Параметр | Значение |
|---|---|
| Старт предзаказа | **16.10.2026 16:00 Asia/Dubai**. На странице Duo: «Pre-order starting at 4:00 p.m. local time on 16/10. Available starting 23/10.» |
| Магазин | ОАЭ, `https://www.apple.com/ae/` (EN, AED) |
| Товар | iPhone Duo 7.6", Star White / Night Sky, 256GB / 512GB / 1TB / 2TB |

### 2.1 Парт-номера и URL (AE)

Шаблон URL: `https://www.apple.com/ae/shop/buy-iphone/iphone-duo/7.6-inch-display-{capacity}-{color}`, где `capacity` ∈ `256gb|512gb|1tb|2tb`, `color` ∈ `star-white|night-sky`.

| Память | Star White | Night Sky |
|---|---|---|
| 256GB | MK244AH/A | MK254AH/A |
| 512GB | MK264AH/A | MK274AH/A |
| 1TB | MK284AH/A | MK294AH/A |
| 2TB | MK2A4AH/A | MK2C4AH/A |

Тесты на живом товаре: iPhone 18 Pro 256GB Black = **MJR54AH/A**, `/ae/shop/buy-iphone/iphone-18-pro/6.3-inch-display-256gb-black`. Полная таблица — в Приложении A.

### 2.2 Магазины ОАЭ

| ID | Магазин | Город в селекте |
|---|---|---|
| R597 | Apple Dubai Mall | Dubai |
| R596 | Apple Mall of the Emirates | Dubai |
| R706 | Apple Al Maryah Island | Abu Dhabi |
| R595 | Apple Yas Mall | Abu Dhabi |
| R785 | Apple Al Jimi Mall (Al Ain) | уточнить по факту |

При выбранном городе Dubai чекаут показывает все 5 магазинов с расстоянием.

---

## 3. Как устроен сайт (по шагам)

### 3.0 Сигнал открытия — JSON без перезагрузки

Тот же эндпоинт, которым пользуется сам сайт:

```
GET https://www.apple.com/ae/shop/fulfillment-messages
    ?fae=true&pl=true&mts.0=regular&mts.1=compact
    &parts.0=MK254AH/A&searchNearby=true&store=R597
```

```jsonc
body.content.deliveryMessage["MK254AH/A"].compact.buyability
  // до старта (снято 28.09 для Duo):
  { "isBuyable": false, "reason": "COMING_SOON", "commitCode": "9942" }
  // после старта ожидается: { "isBuyable": true, ... }
body.content.deliveryMessage["MK254AH/A"].compact.quote       // "Delivers Oct 23"
body.content.pickupMessage.stores[] = {
  storeNumber: "R597", storeName: "Dubai Mall",
  partsAvailability: { "MK254AH/A": {
      pickupDisplay: "ineligible" | "available" | "unavailable",
      pickupSearchQuote: "Currently unavailable" | "Available Today" | "Available Tue 15 Sep" } }
}
```

Для сравнения, живой 18 Pro (MJR54AH/A) 28.09: Dubai Mall и Al Maryah показывали `available / Available Today`, остальные — `unavailable`.

- В одном запросе до 3 партов (`parts.0..2`; на странице `fulfillmentBootstrap.maxParamsPerURL = 3`).
- Запрос вызывается `fetch` из content script на `www.apple.com`: он идёт same-origin с cookie страницы.
- Запасной сигнал: из HTML страницы конфигурации пропадает строка `Pre-order starting`.

### 3.1 Страница конфигурации

Прямая ссылка (§2.1) сразу выбирает модель, цвет и память.

Глобальные объекты страницы (в MAIN world, content script их напрямую не видит, см. §8.4):
- `PRODUCT_SELECTION_BOOTSTRAP.productSelectionData.products[]` — `partNumber`, `dimensionCapacity`, `dimensionColor`, `comingSoon` (у Duo сейчас `true`);
- `fulfillmentBootstrap` — `fulfillmentMessageUrl: "/ae/shop/fulfillment-messages?fae=true"`, `maxParamsPerURL: 3`, cookie магазина `rtsid`.

| data-autom | Что это |
|---|---|
| `dimensionColorstarwhite` / `dimensionColornightsky` | цвет (radio) |
| `dimensionCapacity256gb` … `2tb` | память (radio) |
| `choose-noTradeIn` / `choose-tradeIn` | trade-in (radio, **кликать по `<label>`**) |
| `noapplecare` / `applecare` | AppleCare+ (radio, по label) |
| `add-to-cart` | **Add to Bag** — `<button type=submit name="add-to-cart" value="add-to-cart">`, `disabled`, пока не выбраны trade-in и AppleCare |
| `continueButton` | до старта вместо Add to Bag: «Continue», disabled (у Duo 28.09 именно так) |
| `summary-productName` | название выбранного товара |

Форма Add to Bag: `method=GET`, `action="#"`, скрытые поля `product=<PART>`, `purchaseOption=fullPrice`, `step=select`.

При выборе опций сайт сам шлёт:
```
GET /ae/shop/updateSummary?fae=true&node=home/shop_iphone/family/iphone_18_pro&step=select&product=MJR54AH/A&igt=true
GET /ae/shop/updateSummary?...&acpart=none&igt=true     ← после «No AppleCare»
GET /ae/shop/updateSEO?m={"product":"MJR54AH/A",...}
```

### 3.2 Add to Bag (самое хрупкое место)

Удачный запрос, снят вручную 28.09:

```
GET /ae/shop/buy-iphone/iphone-18-pro/6.3-inch-display-256gb-black
    ?product=MJR54AH/A&purchaseOption=fullPrice&step=select
    &acpart=none&atbtoken=<40 hex>&igt=true&add-to-cart=add-to-cart
→ 200, затем навигация на /ae/shop/buy-iphone/iphone-18-pro?product=mjr54ah/a&step=attach
  параллельно: /ae/shop/beacon/atb, /ae/shop/dc, /ae/shop/buyFlowAttachSummary/MJR54AH/A?...&complete=true,
               /ae/shop/bag/status?apikey=...
```

- `atbtoken` берётся из cookie `as_atb`, в URL его подставляет JS страницы. **URL вручную не строить**, только клик по кнопке.
- `acpart=none` появляется только после выбора «No AppleCare» и ответа `updateSummary`.
- Товар оказывается в корзине **после** цепочки 200 → `step=attach`. Уход со страницы раньше теряет товар (баг v1).
- «Page Not Found» на URL с `add-to-cart=add-to-cart` означает, что запрос отклонён. Разбор — §7.4.

### 3.3 `step=attach`

`/ae/shop/buy-iphone/<family>?product=<part>&step=attach` — допродажа аксессуаров. Отсюда сразу `location.assign('/ae/shop/bag')`.

### 3.4 Корзина `/ae/shop/bag`

| data-autom | Что это |
|---|---|
| `bag-item-name` | название позиции (проверить модель, одна позиция) |
| `item-quantity-dropdown` | количество |
| `bag-item-remove-button` | удалить |
| `checkout` | **Check Out** — `<button type=button>`, `.click()` работает |
| `checkout-with-apple-pay` | Apple Pay Express (обычно только доставка, **[НЕ ПРОВЕРЕНО]**) |
| `bagtotalvalue` | сумма |

Check Out ведёт на `https://secureN.store.apple.com/ae/shop/signIn?ssi=…` (N меняется: 7, 9…).

### 3.5 Вход (`signIn`)

`[data-autom="guest-checkout-btn"]` — **Continue as Guest** (`<button type=button>`, `.click()` работает).

В странице есть `<script id="init_data" type="application/json">` с заголовками XHR (`x-aos-stk`, `x-aos-model-page`, `modelVersion`, `syntax`) и модуль `shldVerify` (Apple Shield — **не трогать**). Дальше открывается `/ae/shop/checkout?_s=Fulfillment-init`.

### 3.6 Fulfillment: самовывоз, магазин, дата, окно (`_s=Fulfillment-init`)

Чекаут — одностраничное приложение: шаг меняется через `history`, параметр `_s` показывает текущий шаг. **Content script обязан отслеживать смену URL без перезагрузки** (§8.3).

| Селектор | Что это |
|---|---|
| `button.rc-segmented-control-button` | «I'd like it delivered» / «I'll pick it up»; выбранная кнопка имеет класс `rc-segmented-control-selected` |
| `select[data-autom="form-field-city"]` | город (Abu Dhabi, Dubai, Sharjah…); по умолчанию Dubai из cookie `rtsid` |
| `input[name="store-locator-result"][value="R597"]` | магазин (radio, кликать по label) |
| `[data-autom="rt-storelocator-searchresult"]` | список магазинов с текстом «Available Today» / «Currently unavailable» |
| `input[name="bartPickupDateSelectorButtonGroup"]` | **дата**, `value` = день месяца (`"28"`); 28.09 было 3 даты вперёд |
| `select[data-autom="pickup-availablewindow-dropdown"]` | **check-in window**, опции `value="28-19:15-19:30"`, шаг 15 мин, первая опция пустая |
| `[data-autom="fulfillment-continue-button"]` | «Continue to Pickup Details» |

Для iPhone check-in window обязателен. Выбор делается на клиенте, на сервер уходит один POST по кнопке Continue:

```
POST /ae/shop/checkoutx/fulfillment?_a=continueFromFulfillmentToPickupContact&_m=checkout.fulfillment
Body (префикс checkout.fulfillment.):
  fulfillmentOptions.selectFulfillmentLocation = RETAIL
  pickupTab.pickup.storeLocator.selectStore    = R597
  pickupTab.pickup.storeLocator.searchInput    = Dubai
  pickupTab.pickup.timeSlot.dateTimeSlots.date          = 2026-09-28
  pickupTab.pickup.timeSlot.dateTimeSlots.startTime     = 07:15 PM
  pickupTab.pickup.timeSlot.dateTimeSlots.endTime       = 07:30 PM
  pickupTab.pickup.timeSlot.dateTimeSlots.timeZone      = Asia/Dubai
  pickupTab.pickup.timeSlot.dateTimeSlots.timeSlotValue = 28-19:15-19:30
  pickupTab.pickup.timeSlot.dateTimeSlots.dayRadio      = 28
  pickupTab.pickup.timeSlot.dateTimeSlots.timeSlotId    = <148 символов от сервера>
  pickupTab.pickup.timeSlot.dateTimeSlots.signKey       = <подпись от сервера>
```

`timeSlotId` и `signKey` выдаёт сервер, поэтому **выбирать только через UI**. Успех — URL `_s=PickupContact-init`.

Остальные действия шага (из `init_data`, путь `checkout.fulfillment.a.*`, все на `/ae/shop/checkoutx/fulfillment`): `selectFulfillmentLocationAction`, `storeLocatorView`, `select`, `search`, `Apply`, `city-warm-up`.

Фолбэк доставки:
- переключить на «delivered»;
- отметить радио `input[data-autom^="fulfillment-option"]` (по одному на группу);
- нажать ту же кнопку («Continue to Shipping Address») → `_s=Shipping-init`;
- заполнить поля `form-field-firstName/lastName/street/street2 (Area, обяз.)/city/emailAddress/mobilePhone`, кнопка `shipping-continue-button`.

### 3.7 Контакты получателя (`_s=PickupContact-init`)

| data-autom | Что это |
|---|---|
| `selfPickup` / `thirdPartyPickup` | кто забирает |
| `form-field-firstName`, `form-field-lastName` | имя, фамилия |
| `form-field-emailAddress` | email |
| `form-field-mobilePhone` | мобильный, **обязателен**, `05XXXXXXXX` |
| `continue-button-label` | «Continue to Payment» |

```
POST /ae/shop/checkoutx?_a=continueFromPickupContactToBilling&_m=checkout.pickupContact
checkout.pickupContact.pickupContactOptions.selectedPickupOption = SELF
checkout.pickupContact.selfPickupContact.selfContact.address.{firstName,lastName,emailAddress,mobilePhone}
```

Успех — `_s=Billing-init`. Поля — это React-инпуты, заполнять по §8.2.

### 3.8 Оплата (`_s=Billing-init`) — граница автоматизации

| data-autom | Что это |
|---|---|
| `checkout-billingOptions-CREDIT` | карта (radio) |
| `checkout-billingOptions-APPLE_PAY` | Apple Pay (radio) |
| `card-number-input`, `expiration-input`, `security-code-input` | поля карты — **расширение их не заполняет** |
| `form-field-taxRegNumber` | TRN (опц.) |
| `continue-button-review` | «Review Your Order» → `_s=Review` **[НЕ ПРОВЕРЕНО]** |

Заголовок экрана: «How do you want to pay?».

### 3.9 Review / Place Order **[НЕ ПРОВЕРЕНО]**

Ожидается `_s=Review` с кнопкой «Place Order», затем возможен 3-D Secure, затем страница подтверждения с номером `W\d{9,11}`. Расширение здесь только наблюдает.

### 3.10 Оверлеи и плохие состояния

| Состояние | Признак | Реакция |
|---|---|---|
| До старта | есть `continueButton`, нет `add-to-cart`; текст `Pre-order starting` | рефреш по §7.3 |
| Заглушка | `so are we` / `Almost there` / `Be right back` / `busy right now` / `high demand` / `isn't available right now`; HTTP 503/541 | рефреш с джиттером |
| **Выбор страны** (v2) | баннер или модалка со списком стран и кнопкой **Continue** (разметка **[НЕ СНЯТА]**) | §7.5 |
| 404 на Add to Bag | title `Page Not Found - Apple`, «can't be found», URL содержит `add-to-cart=add-to-cart` | §7.4 |
| 404 после Guest | `Page Not Found` на `secureN.store.apple.com` | в корзину → Check Out |
| Пустая корзина | нет `bag-item-name`, текст «Your bag is empty.» | повтор Add to Bag |
| Сессия истекла | редирект в корзину или `signIn` | с Check Out |
| Слот занят | остались на Fulfillment + текст ошибки | следующий слот/магазин |
| Нет самовывоза | все магазины `Currently unavailable` / `Not available for pickup` | фолбэк доставки или стоп |
| Лимит | `maximum of N … per customer` | 1 шт. |
| Ночные работы Apple | 404/503 на чекауте (видели 12.09 ~01:30–02:30) | ждать |

### 3.11 Cookie и токены

- `as_atb` — токен Add to Bag.
- `rtsid` — магазин/город (180 дней).
- `geo`, `as_dc`, `as_sfa`, `shld_bt_ck`, `shld_bt_m`, `pxro`, `accs` — гео, дата-центр, Shield.
- `x-aos-stk` — в `init_data` каждой страницы чекаута.

**Вывод:** один профиль Chrome = одна сессия = одна корзина = один заказ одновременно. Вкладки одного профиля делят корзину.

---

## 4. Уроки живых тестов (28.09)

1. **Корзина пуста после Add to Bag.** Уходили со страницы на промежуточном URL `add-to-cart=`. Правило: ждать `step=attach` или `/shop/bag`.
2. **Page Not Found на Add to Bag** в окнах Playwright. Причина не установлена. Гипотезы и диагностика — §7.4.
3. **Выбор страны** в части окон: свежие профили без гео-cookie и, возможно, VPN.
4. Жёлтая плашка `--no-sandbox` и Google Translate — артефакты Playwright, к расширению не относятся.

---

## 5. Архитектура расширения

### 5.1 Компоненты

```
┌──────────────── Профиль Chrome «Drop 1» ────────────────┐
│  Service worker (sw.js) — оркестратор профиля            │
│   • конфиг, состояние заказа профиля, лок Add to Bag      │
│   • роль «наблюдатель» → одной вкладке                    │
│   • уведомления, звук (offscreen), фокус окна             │
│   • WebSocket к хабу (если запущен)                       │
│        ▲ chrome.runtime.connect (порт на каждую вкладку)   │
│  Content script (content.js) в каждой вкладке apple.com   │
│   • классификация страницы, шаги §6, DOM-действия §8      │
│   • оверлей-статус в углу страницы                        │
│  Popup / Side panel — старт/стоп, статус, «следующий»     │
│  Options page — конфиг (JSON-редактор + форма)            │
└──────────────────────────────────────────────────────────┘
          │ ws://127.0.0.1:8765  (необязательно)
┌─────────┴───────── Хаб (hub/, Node, ~150 строк) ─────────┐
│  • общий сигнал OPEN для всех профилей                    │
│  • правило победителя между профилями одного заказа       │
│  • очередь оплаты между профилями                         │
│  • дашборд http://127.0.0.1:8765 (таблица окон, лог)      │
└──────────────────────────────────────────────────────────┘
```

Без хаба каждый профиль работает автономно: один профиль = один заказ, гонка идёт между вкладками профиля. С хабом добавляется гонка между профилями за один заказ, общий дашборд и общая очередь оплаты.

### 5.2 manifest.json

```json
{
  "manifest_version": 3,
  "name": "Apple Drop Assistant",
  "version": "3.0.0",
  "minimum_chrome_version": "120",
  "permissions": ["storage", "tabs", "notifications", "offscreen", "webRequest", "alarms"],
  "host_permissions": [
    "https://www.apple.com/ae/*",
    "https://*.store.apple.com/*",
    "http://127.0.0.1/*"
  ],
  "background": { "service_worker": "sw.js", "type": "module" },
  "content_scripts": [{
    "matches": ["https://www.apple.com/ae/*", "https://*.store.apple.com/ae/*"],
    "js": ["content.js"],
    "run_at": "document_idle",
    "all_frames": false
  }],
  "action": { "default_popup": "popup.html" },
  "options_page": "options.html"
}
```

- Для тестов на мок-сервере в dev-сборке добавить в `host_permissions` и `matches` `http://127.0.0.1:4777/*`.
- `webRequest` используется **только для наблюдения** (статусы запросов `/ae/shop/*` в лог диагностики), без блокировки и без модификации.
- Content scripts в MV3 не поддерживают ES-модули напрямую. Исходники на TypeScript/ESM собирать **esbuild** в `dist/` (один бандл на `content.js`, `sw.js`, `popup.js`, `options.js`, `offscreen.js`).

### 5.3 Структура проекта

```
apple-drop-assistant/
  manifest.json
  package.json                  # esbuild, типы chrome
  build.mjs                     # сборка в dist/, dev/prod manifest
  src/
    sw/
      index.ts                  # вход service worker
      orchestrator.ts           # состояние профиля, лок Add to Bag, роли вкладок
      watcher.ts                # управление наблюдателем (§7.3)
      hubClient.ts              # WebSocket к хабу, реконнект
      notify.ts                 # chrome.notifications + звук через offscreen
      windows.ts                # фокус окна, очередь оплаты
      diag.ts                   # webRequest-наблюдение для §7.4
    content/
      index.ts                  # вход: классификация → шаг
      classify.ts               # §3.10
      router.ts                 # отслеживание смены _s без перезагрузки (§8.3)
      dom.ts                    # waitFor, click, setSelect, setInput (§8)
      steps/
        preopen.ts              # рефреш до старта
        country.ts              # §7.5
        addToBag.ts             # §7.4
        bag.ts                  # проверка/очистка, Check Out
        guest.ts
        fulfillment.ts          # §6.5
        contact.ts
        payment.ts              # §7.7 (только выбор способа и наблюдение)
      overlay.ts                # плашка статуса на странице
      assist.ts                 # режим ассистента (§7.8)
    shared/
      config.ts                 # схема + валидация
      selectors.ts              # ВСЕ селекторы и тексты (§9)
      parts.ts                  # парт-номера и URL
      messages.ts               # типы сообщений SW ↔ content ↔ hub
      log.ts
    ui/
      popup.html/.ts            # старт/стоп, статус вкладок, «следующий на оплату»
      options.html/.ts          # конфиг, импорт/экспорт JSON
      offscreen.html/.ts        # проигрывание звука
  hub/
    server.mjs                  # WebSocket + дашборд (Node 20+, пакет ws)
  test/
    mock-server.mjs             # макет apple.com/ae (§11.1)
  scripts/
    open-profiles.command       # macOS: открыть N профилей Chrome
```

### 5.4 Сообщения

```ts
// content → SW
{ t: 'HELLO', url, kind }                       // вкладка загрузилась, тип страницы
{ t: 'STATE', state, detail }                   // смена состояния машины (§6)
{ t: 'ATB_LOCK_REQ' }                           // можно жать Add to Bag?
{ t: 'ATB_RESULT', ok, outcome, diag }          // OK | ATB_404 | BUSY | ATB_TIMEOUT
{ t: 'BILLING_READY', store, slot }
{ t: 'ORDERED', orderNo }
{ t: 'LOG', level, msg }

// SW → content
{ t: 'ROLE', role: 'watcher' | 'racer' | 'standby' | 'idle' }
{ t: 'OPEN' }                                   // продажи открыты
{ t: 'ATB_LOCK', granted: boolean }
{ t: 'STOP' }                                   // заказ взят другой вкладкой/профилем
{ t: 'GO_BAG' }                                 // стать ведущей вкладкой после победы
{ t: 'FOCUS_FOR_PAY' }

// SW ↔ hub (JSON по WebSocket)
{ t: 'REGISTER', profile, orderId, tabs }
{ t: 'OPEN' }
{ t: 'WIN_REQ', orderId, profile } / { t: 'WIN', orderId, profile } / { t: 'LOSE', orderId }
{ t: 'PAY_READY', orderId, profile } / { t: 'PAY_TURN', orderId, profile }
{ t: 'STATUS', ... }                            // для дашборда
```

**Жизнь service worker.** Каждая вкладка держит порт `chrome.runtime.connect` (переподключение при разрыве). WebSocket к хабу шлёт ping каждые 20 с. Таймеры рефреша живут **в content script**, а не в SW: `chrome.alarms` не даёт интервалов меньше 30 с, а SW может быть выгружен.

---

## 6. Машина состояний вкладки

```
IDLE → ARMED (на странице конфигурации цели, ждёт openAt-60s)
ARMED → PRE_RELOAD (рефреш каждые preOpenReloadMs ± джиттер)
PRE_RELOAD ──(OPEN или add-to-cart активна)──► FAST_RELOAD / ATB_PREP
ATB_PREP (опции, ждём updateSummary) → ATB_WAIT_LOCK → ATB_PENDING
ATB_PENDING ──ok──► IN_BAG ──(SW: победитель)──► CHECKOUT
                               └─(SW: не победитель)──► STANDBY → CLEANUP (§7.1)
ATB_PENDING ──404/busy/timeout──► FAST_RELOAD (backoff) ──(atb404MaxInRow)──► STUCK
CHECKOUT → GUEST → FULFILLMENT → CONTACT → BILLING_READY → PAY_QUEUE → PAYING (человек) → ORDERED | PAY_TIMEOUT
любое ──(выбор страны)──► COUNTRY → возврат в прежнее состояние
любое ──(заглушка)──► reload с backoff
любое ──(STOP от SW)──► IDLE
```

Состояние вкладки хранится в `chrome.storage.session` под ключом `tab:<tabId>`, чтобы пережить перезагрузку страницы. На каждой загрузке content script:
1. читает своё состояние;
2. классифицирует страницу (§3.10);
3. продолжает с нужного шага.

Отдельный ключ `order` хранит состояние заказа профиля: `winnerTabId`, `inBag`, `stage`, `store`, `slot`, `timestamps`.

---

## 7. Функциональные требования

### 7.1 Много окон (Apple пропускает волнами)

**Два уровня гонки:**
- **Вкладки внутри профиля** (без хаба). В профиле открыто K вкладок (`racersPerProfile`, по умолчанию 3) на странице конфигурации цели, каждая рефрешит независимо. Корзина общая, поэтому Add to Bag жмёт **только владелец лока**: SW выдаёт `ATB_LOCK` первой вкладке, у которой кнопка стала активной. TTL лока — `atbTimeoutMs` (15 с). При неудаче лок переходит к следующей вкладке. После успеха остальные вкладки профиля получают `STOP` и становятся `IDLE` (их можно закрыть). Ведущей становится вкладка-победитель.
- **Профили за один заказ** (нужен хаб). Один заказ ведут P профилей (`profilesPerOrder`), у каждого своя корзина. Первый профиль с товаром в корзине сообщает `WIN_REQ` и получает `WIN`. Остальные получают `LOSE`, переходят в `STANDBY` и **держат товар `holdLoserBagSec` (90 с)** как запас. Если победитель упал на чекауте, хаб отдаёт заказ следующему профилю из STANDBY. Когда победитель дошёл до `BILLING_READY`, проигравшие чистят корзины (`bag-item-remove-button`).

Какой уровень работает в реальности, покажут тесты: если «волны» Apple привязаны к сессии/cookie, вкладки одного профиля ничего не дают, и нужны профили.

**Профили Chrome:**
- создаются вручную (Chrome → «Добавить профиль»), имена `Drop 1 … Drop N`;
- в каждый расширение ставится через `chrome://extensions` → «Режим разработчика» → «Загрузить распакованное» (`dist/`);
- `scripts/open-profiles.command` открывает все профили: `open -na "Google Chrome" --args --profile-directory="Profile N"`;
- соответствие «профиль → заказ» задаётся в конфиге каждого профиля (`profileId`, `orderId`).

**Лимиты:**
- всего окон/вкладок с одного интернета — до 12;
- рефреш вкладки — не чаще `minReloadMs` = 1500 мс;
- JSON-наблюдатель — не чаще раза в 1000 мс на профиль (при хабе — один наблюдатель на всех).

### 7.2 Нагрузка и джиттер

Все интервалы умножаются на случайный множитель `1 ± jitterPct/100` (по умолчанию 30%), чтобы вкладки не били синхронно. Кроме того, по сигналу OPEN каждая вкладка делает первый рефреш со случайной задержкой 0–500 мс.

### 7.3 Рефреш до активации и сигнал OPEN

**Наблюдатель.** SW назначает роль `watcher` одной вкладке профиля (при хабе — одной на всех). Эта вкладка каждые `pollMs` (1200 мс) делает `fetch` к §3.0 для всех `targets` (по 3 за запрос).
- Если `isBuyable === true` хотя бы у одного — сообщение `OPEN` в SW, а через SW в хаб и все вкладки.
- Запасной сигнал: из HTML страницы конфигурации пропала строка `Pre-order starting` (проверять раз в 3 цикла).

**Рефреш вкладок:**
- до `openAt − 60 с` — без рефреша;
- с `openAt − 60 с` до OPEN — `location.reload()` каждые `preOpenReloadMs` (3000 мс);
- после OPEN или если сигнала нет к `openAt + graceSec` (20 с) — каждые `postOpenReloadMs` (1500 мс), пока не появится активная Add to Bag;
- после каждой загрузки — классификация, и как только `add-to-cart` есть, сразу §7.4, без ожидания других вкладок.

### 7.4 Add to Bag (без «Page Not Found»)

**Алгоритм:**
1. Дождаться гидратации: `[data-autom="choose-noTradeIn"]` в DOM и `[data-autom="add-to-cart"]` в DOM.
2. Проверить, что выбран нужный товар: скрытое поле `product` в форме Add to Bag равно целевому `part`. Если нет — `location.assign(URL цели)`.
3. Клик по label «No trade-in». Дождаться ответа `updateSummary` (§8.5), таймаут 5 с.
4. Клик по label «No AppleCare». Дождаться `updateSummary` с `acpart=none`, таймаут 5 с.
5. Дождаться, пока `add-to-cart` станет `enabled` сама. **Не снимать `disabled` руками.**
6. Запросить у SW лок (`ATB_LOCK_REQ`). Без лока не жать.
7. `button.scrollIntoView({block:'center'})`, затем `button.click()`.
8. Результат ловится на **следующей загрузке страницы**: content script стартует заново и видит новый URL. В `chrome.storage.session` заранее записать `atbPendingSince` и `part`. Исходы:
   - URL `step=attach` или `/shop/bag` → `OK` → `location.assign('/ae/shop/bag')` и проверка корзины;
   - title/текст «Page Not Found» и URL с `add-to-cart=` → `ATB_404`;
   - заглушка → `BUSY`;
   - прошло больше `atbTimeoutMs` без смены страницы → `ATB_TIMEOUT`.
9. **Если страница с `add-to-cart=` в URL загрузилась без ошибки (200) — ничего не делать и не уходить**, ждать, пока сайт сам перейдёт на `step=attach` (до 15 с).
10. В корзине: `bag-item-name` содержит нужную модель, позиция одна, количество 1. Лишнее удалить.

**`ATB_404`:**
- записать диагностику, освободить лок;
- выждать `atb404BackoffMs` (1500 мс ± джиттер) и `location.assign(URL цели)`;
- после `atb404MaxInRow` (5) подряд вкладка переходит в `STUCK`, остальные вкладки и профили продолжают.

**Диагностика `ATB_404`** (в лог и в дашборд):
- URL запроса (значение `atbtoken` замаскировать до 4 символов);
- были ли в URL `acpart=none`, `atbtoken`, `igt=true`, `product`;
- видели ли ответ `updateSummary` с `acpart=none` до клика;
- `performance.getEntriesByType('navigation')[0].responseStatus`;
- статусы из `webRequest` по `/ae/shop/*` за последние 10 с;
- наличие cookie `as_atb` и `geo` (content script видит `document.cookie` без HttpOnly; в лог только имена и значение `geo`);
- `navigator.language`, `Intl.DateTimeFormat().resolvedOptions().timeZone`;
- текущая страна в URL (`/ae/`).

**Гипотезы 404 и что проверить:**

| # | Гипотеза | Признак | Лечение |
|---|---|---|---|
| 1 | Клик до гидратации / до `updateSummary` | в URL нет `acpart=none` или пустой `atbtoken` | шаги 1–6 |
| 2 | Гео/страна (VPN, свежий профиль) | 404 в тех же окнах, где был выбор страны; `geo` ≠ AE | §7.5, выключить VPN, прогрев профилей |
| 3 | Товар ещё не продаётся | 404 в первые минуты после 16:00, потом проходит | повторы |
| 4 | Apple отвергает программный клик | 1–3 исключены; руками в той же вкладке проходит, `.click()` — нет | режим ассистента §7.8 для шага Add to Bag. Не маскировать |

### 7.5 Страна и регион (AE)

**Прогрев (кнопка «Prepare» в popup, делать за 1–24 ч до дропа).** В каждом профиле:
1. открыть `https://www.apple.com/ae/`;
2. если есть выбор страны — выбрать «United Arab Emirates» и Continue (или «Stay on UAE», или закрыть);
3. открыть `/ae/shop/bag` и очистить корзину;
4. открыть конфигурацию цели и проверить `/ae/` в URL, цены в AED и отсутствие баннера;
5. отметить профиль `prepared: true` с временем.

**В бою** — `handleCountry()` перед каждым шагом:
- найти контейнер, где текст совпадает с `txtCountry` (§9);
- внутри найти `<select>` страны или список ссылок;
- выбрать вариант с текстом «United Arab Emirates» или ссылкой на `/ae/`;
- нажать Continue или ссылку;
- дождаться пропадания оверлея;
- если URL ушёл не на `/ae/` — `location.assign(URL цели)`;
- лог `COUNTRY_PICKER`; 3 раза подряд → `STUCK`.

**Точная разметка баннера не снята.** Разработчику: открыть свежий профиль или профиль с VPN, снять DOM и зафиксировать в `selectors.ts`.

**Окружение:** VPN выключен; язык Chrome English; часовой пояс Mac — Дубай.

### 7.6 Чекаут (после корзины)

**Check Out:** `[data-autom="checkout"].click()`. Через 5 с без смены URL — повтор. Если не помогает, режим ассистента для этой кнопки.

**Guest:** `[data-autom="guest-checkout-btn"].click()`. При 404 — `/ae/shop/bag` и снова Check Out (до `retries.checkout` = 4).

**Fulfillment** (§3.6):
1. Если не выбрано, клик по кнопке «pick it up».
2. Город: `setSelect(city, cfg.city)` (§8.2). Если уже стоит нужный — пропустить.
3. Дождаться списка магазинов (MutationObserver, 10 с).
4. Для каждого магазина из `stores` по порядку:
   - если его карточка содержит `unavailable|Not available` — пропустить;
   - клик по label радио магазина, дождаться появления дат (5 с);
   - дата: `slot.day` или первая доступная; клик по label;
   - дождаться опций в `pickup-availablewindow-dropdown`;
   - упорядочить окна: сначала ≥ `slot.after` и ≤ `slot.before`, затем остальные;
   - для первых `slotsPerStore` окон: `setSelect(slotSelect, value)`, клик Continue, ждать смены `_s` на `PickupContact` **или** появления нового текста ошибки (`txtSlotError`), что раньше. Ошибка → следующее окно.
5. Самовывоза нет нигде: если `deliveryFallback` — доставка (§3.6), иначе `STUCK` с уведомлением «нет самовывоза».

**Контакты** (§3.7): клик `selfPickup`, `setInput` по четырём полям, клик `continue-button-label`, ждать `_s=Billing` или текст `Please …`. Ошибка — стоп вкладки с текстом Apple в уведомлении.

### 7.7 Два модуля оплаты

Модуль задаётся на заказ: `payment: "manual" | "applepay"`. В обоих расширение доводит до `_s=Billing-init`, выбирает способ, ставит вкладку в **очередь оплаты** и выводит её человеку. **Финальное действие всегда за человеком.**

**Модуль A — `manual` (карта руками):**
1. Клик по label `checkout-billingOptions-CREDIT`.
2. Прокрутить к полю `card-number-input` и поставить в него фокус (`focus()` без ввода).
3. `FOCUS_FOR_PAY`: SW делает `chrome.windows.update(winId, {focused:true, drawAttention:true})` и `chrome.tabs.update(tabId, {active:true})`, показывает уведомление «Заказ A: введи карту», играет звук.
4. На странице — крупная плашка: «Заказ A · Dubai Mall · 16 Oct 16:45–17:00 · введи карту и нажми Review → Place Order».
5. Человек вводит карту (удобно, если карта сохранена в автозаполнении Chrome этого профиля: выбрать и ввести CVV), жмёт Review Your Order → Place Order, проходит 3-D Secure.
6. Расширение наблюдает: `_s=Review` → «ждём Place Order»; страница с `W\d{9,11}` → `ORDERED`. Номер показать в popup, дашборде и уведомлении. Через `manualPayTimeoutSec` (600) без подтверждения → `PAY_TIMEOUT`.

**Модуль B — `applepay`:**
1. Клик по label `checkout-billingOptions-APPLE_PAY`.
2. `FOCUS_FOR_PAY` с уведомлением «Заказ A: подтверди Apple Pay».
3. Человек жмёт кнопку продолжения/оплаты Apple Pay и подтверждает Touch ID или на iPhone (QR/уведомление — зависит от macOS и Chrome, **[ПРОВЕРИТЬ]**).
4. Наблюдение и фиксация номера — как в модуле A.
5. Если Apple Pay в Chrome в профиле не работает (проверить заранее, тест T5), для заказа включается `applePayFallback: "manual"`.
6. Путь `checkout-with-apple-pay` из корзины не использовать (там нет слота), кроме случая `allowApplePayExpress: true` и отсутствия самовывоза.

**Очередь оплаты:**
- SW (или хаб для нескольких профилей) держит впереди **одну** вкладку;
- следующая выводится, когда текущая дошла до `_s=Review` или `ORDERED`, либо по кнопке «Следующий» в popup или на дашборде;
- порядок — по `priority` заказа, затем по времени `BILLING_READY`;
- на плашке и в popup виден таймер «слот выбран N с назад» (время удержания слота Apple **[НЕ ИЗМЕРЕНО]**).

### 7.8 Режим ассистента

Включается глобально (`mode: "assist"`) или автоматически для конкретного шага после `assistAfterFailures` (3) неудач программного клика на этом шаге (Add to Bag, Check Out, Guest).

Что делает:
- расширение готовит всё до кнопки (опции, город, магазин, слот, поля);
- обводит кнопку ярко-зелёной рамкой, прокручивает к ней, выводит окно вперёд и играет звук;
- **человек нажимает кнопку**;
- расширение ловит результат и продолжает следующий шаг автоматически.

Цель — сохранить скорость везде, где программный клик проходит, и не терять заказ там, где не проходит.

### 7.9 UI

**Плашка на странице** (Shadow DOM, правый верхний угол, не перекрывает кнопки Apple): профиль, заказ, состояние, счётчики (рефреши, 404), таймер. Кнопки «Пауза» и «Скрыть».

**Popup:**
- статус профиля и таблица вкладок (роль, состояние, последний исход);
- кнопки: **Start** (открыть K вкладок на цели и взвести), **Stop**, **Prepare** (§7.5), **Clean bag**, **Следующий на оплату**, **Режим ассистента вкл/выкл**, **Экспорт лога**.

**Options:**
- форма заказа: цели по приоритету, магазины, город, слот, способ оплаты, контакт, фолбэки;
- JSON-редактор конфига с валидацией;
- импорт/экспорт;
- адрес хаба.

**Дашборд хаба** (`http://127.0.0.1:8765`): таблица «заказ × профиль × вкладка» с состоянием и временем от OPEN, общий лог, кнопка «Следующий на оплату», итог с номерами заказов.

### 7.10 Логи

- Каждый шаг — `[HH:MM:SS.mmm +сек от OPEN] [profile · order · tab] состояние: текст`.
- Хранение в `chrome.storage.local` (кольцевой буфер ~5000 строк), экспорт в `.txt` из popup, дублирование в хаб.
- **Не логировать** значения cookie и токенов, платёжные данные (расширение их и не касается), полные email/телефоны (маскировать).

---

## 8. Техника DOM-действий в content script

### 8.1 Ожидания

- `waitFor(selector, timeout)` — через `MutationObserver` плюс проверка сразу, без частого поллинга.
- `waitForText(regex, root, timeout)`.
- `waitForUrl(regex, timeout)` — см. §8.3.
- `raceFirst([...])` — ждать первое из нескольких условий (смена шага **или** текст ошибки).

### 8.2 Действия (React-совместимые)

```ts
// клик по radio через label
function pickRadio(input: HTMLInputElement) {
  const label = input.labels?.[0] ?? input.closest('label') ?? input;
  (label as HTMLElement).click();
}

// select: нативный сеттер + события (простое el.value = x Apple НЕ видит — проверено)
function setSelect(el: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

// текстовое поле
function setInput(el: HTMLInputElement, value: string) {
  el.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
}
```

После `setSelect` и `setInput` **проверять**, что приложение приняло значение: для слота должны активироваться Continue и текст выбранного окна; для полей не должно быть ошибки валидации после blur. Если `setSelect` не принят (**[ПРОВЕРИТЬ]** на живом сайте — город, окно слота), для этого поля включается режим ассистента: подсветить select и попросить выбрать руками.

Поле с `data-autom` может быть либо самим `<input>`, либо обёрткой. Искать так: `input${sel}, ${sel} input`.

### 8.3 Одностраничный чекаут

На `secureN.store.apple.com/ae/shop/checkout` шаги меняются через `history.pushState` без перезагрузки. В content script:
- опрос `location.href` каждые 150 мс (простой и надёжный вариант; события `popstate` на `pushState` не приходят);
- при смене `_s` — вызвать обработчик нового шага.

### 8.4 Данные страницы из MAIN world

Content script живёт в изолированном мире и не видит `window.PRODUCT_SELECTION_BOOTSTRAP`. Эти данные нужны только для отладки, основная логика на них не опирается. Если понадобятся — небольшой скрипт с `"world": "MAIN"` (отдельная запись в `content_scripts`) читает нужные поля и передаёт через `window.postMessage` с проверкой `event.source === window` и своего маркера. Функции сайта **не вызывать**.

### 8.5 Как «дождаться updateSummary» без перехвата сети

- **Вариант 1:** `performance.getEntriesByType('resource')` + `PerformanceObserver({type:'resource'})`. Ждать запись, у которой `name` содержит `/shop/updateSummary` (и `acpart=none` для шага 4) и `responseEnd > t0`.
- **Вариант 2 (запасной):** SW через `webRequest.onCompleted` (фильтр `*://www.apple.com/ae/shop/updateSummary*`) шлёт вкладке событие.

Перехват `fetch` или `XMLHttpRequest` страницы не делать.

---

## 9. Селекторы (`shared/selectors.ts`)

```ts
export const SEL = {
  // конфигурация
  noTradeIn: '[data-autom="choose-noTradeIn"]',
  noAppleCare: '[data-autom="noapplecare"]',
  addToBag: '[data-autom="add-to-cart"]',
  continueDisabled: '[data-autom="continueButton"]',
  productName: '[data-autom="summary-productName"]',
  // корзина
  bagItemName: '[data-autom="bag-item-name"]',
  bagItemRemove: '[data-autom="bag-item-remove-button"]',
  bagCheckout: '[data-autom="checkout"]',
  bagApplePay: '[data-autom="checkout-with-apple-pay"]',
  // вход
  guest: '[data-autom="guest-checkout-btn"]',
  // fulfillment
  segmented: 'button.rc-segmented-control-button',
  segmentedSelectedClass: 'rc-segmented-control-selected',
  city: 'select[data-autom="form-field-city"]',
  storeRadio: (id: string) => `input[name="store-locator-result"][value="${id}"]`,
  storeResults: '[data-autom="rt-storelocator-searchresult"]',
  dateRadio: 'input[name="bartPickupDateSelectorButtonGroup"]',
  slotSelect: 'select[data-autom="pickup-availablewindow-dropdown"]',
  fulfillmentContinue: '[data-autom="fulfillment-continue-button"]',
  deliveryOption: 'input[data-autom^="fulfillment-option"]',
  // контакты
  selfPickup: '[data-autom="selfPickup"]',
  firstName: '[data-autom="form-field-firstName"]',
  lastName: '[data-autom="form-field-lastName"]',
  email: '[data-autom="form-field-emailAddress"]',
  phone: '[data-autom="form-field-mobilePhone"]',
  contactContinue: '[data-autom="continue-button-label"]',
  // оплата: только выбор способа и фокус
  payCard: '[data-autom="checkout-billingOptions-CREDIT"]',
  payApplePay: '[data-autom="checkout-billingOptions-APPLE_PAY"]',
  cardNumberFocusOnly: '[data-autom="card-number-input"]',
  // тексты
  txtPreorder: 'Pre-order starting',
  txtBusy: /(so are we|Almost there|Be right back|busy right now|high demand|isn.t available right now)/i,
  txt404: /can.t be found|Page Not Found/i,
  txtCountry: /(Choose another country or region|country or region|You.re viewing)/i, // уточнить по живой разметке
  txtSlotError: /(no longer available|not available for|Please select|Please choose)/i,
  txtEmptyBag: /Your bag is empty/i,
  txtOrderNo: /\bW\d{9,11}\b/,
};
```

---

## 10. Конфиг

Хранится в `chrome.storage.local`, редактируется в Options. Для удобства — один JSON на все профили, в каждом профиле указывается свой `profileId`.

```jsonc
{
  "profileId": "drop-1",                 // уникален в каждом профиле
  "hubUrl": "ws://127.0.0.1:8765",       // пусто = без хаба
  "openAt": "2026-10-16T16:00:00+04:00",
  "mode": "auto",                        // auto | assist
  "orders": [
    {
      "id": "A",
      "priority": 1,
      "profiles": ["drop-1", "drop-2"],  // какие профили ведут заказ (при хабе)
      "racersPerProfile": 3,             // вкладок в профиле
      "targets": ["MK254AH/A", "MK244AH/A"],   // по приоритету
      "stores": ["R597", "R596", "R706"],
      "city": "Dubai",
      "slot": { "day": null, "after": null, "before": null },
      "payment": "applepay",             // manual | applepay
      "applePayFallback": "manual",
      "contact": { "firstName": "", "lastName": "", "email": "", "phone": "05XXXXXXXX" },
      "deliveryFallback": false,
      "address": { "street": "", "area": "", "city": "Dubai" }
    }
  ],
  "timing": {
    "pollMs": 1200, "preOpenReloadMs": 3000, "postOpenReloadMs": 1500, "minReloadMs": 1500,
    "jitterPct": 30, "graceSec": 20, "atbTimeoutMs": 15000, "atb404BackoffMs": 1500,
    "atb404MaxInRow": 5, "holdLoserBagSec": 90, "manualPayTimeoutSec": 600, "assistAfterFailures": 3
  },
  "retries": { "checkout": 4, "slotsPerStore": 4 },
  "limits": { "maxTabsTotal": 12 },
  "baseUrl": "https://www.apple.com"     // для мока: http://127.0.0.1:4777
}
```

Валидация при сохранении:
- телефон `^05\d{8}$`, email, непустые имена;
- `targets` есть в `parts.ts`, `stores` только из §2.2;
- профиль назначен ровно одному заказу;
- сумма вкладок не больше `maxTabsTotal`;
- `openAt` в будущем.

---

## 11. Тестирование

### 11.1 Мок-сервер (`test/mock-server.mjs`)

За основу взять макет из v1 и добавить:
- `OPEN_AFTER=N` — «продажи» открываются через N с;
- заглушка «Almost there» на первый заход сессии после открытия;
- Add to Bag как на живом сайте: GET → 200 → через ~900 мс `beacon/atb` → переход на `step=attach`;
- `ATB_404_RATE` — доля 404 на Add to Bag; 404 всегда, если в URL нет `acpart=none` или `atbtoken`;
- `ACPART_DELAY_MS` — задержка ответа `updateSummary`, чтобы проверить шаги 3–5 §7.4;
- `COUNTRY_PICKER=1` — баннер выбора страны для сессии без cookie `geo=AE`;
- `REQUIRE_TRUSTED=1` — сервер «отклоняет» Add to Bag, если форма отправлена программно (эмуляция через скрытое поле, которое заполняет только настоящий клик по `pointerdown`). Нужно, чтобы проверить автопереход в режим ассистента;
- одностраничный чекаут на `pushState`, занятый первый слот, магазин без наличия, неверный телефон, экран Billing с радио CARD/APPLE_PAY.

Dev-сборка расширения с `baseUrl=http://127.0.0.1:4777` и соответствующими `host_permissions`.

### 11.2 Живые тесты (до 16.10, на iPhone 18 Pro 256 Black — MJR54AH/A)

| # | Тест | Критерий |
|---|---|---|
| T1 | 1 профиль, 1 вкладка, `mode: auto` | дошли до «How do you want to pay?» со слотом; затем Clean bag |
| T2 | 1 профиль, 3 вкладки | Add to Bag нажала одна вкладка, в корзине 1 шт. |
| T3 | Проверка гипотезы 4 (§7.4) | если `.click()` по Add to Bag даёт 404, а ручной клик в той же вкладке — нет, включить `assist` для этого шага и зафиксировать |
| T4 | Свежий профиль + (опционально) VPN | снять разметку выбора страны, проверить `handleCountry()` |
| T5 | Apple Pay в Chrome в профиле | выбрать APPLE_PAY, дойти до листа Apple Pay, **не подтверждать**; снять селекторы Review |
| T6 | 3 профиля + хаб | правило победителя, STANDBY, очистка у проигравших, очередь оплаты |
| T7 | `setSelect` для города и окна слота | приложение принимает значение, Continue проходит |

**Не платить ни в одном тесте.** После каждого теста — Clean bag во всех профилях.

### 11.3 Критерии приёмки

- [ ] Мок: 3 заказа × 2 профиля × 2 вкладки → 3 заказа на Billing ≤ 10 с после OPEN, без дублей.
- [ ] Мок: 404, заглушки, выбор страны, занятый слот отрабатываются без человека.
- [ ] Мок: при `REQUIRE_TRUSTED=1` вкладка переходит в режим ассистента на Add to Bag, человек кликает, дальше всё автоматически.
- [ ] Живые T1–T7 пройдены или их результат зафиксирован.
- [ ] Модуль `manual`: способ выбран, фокус в поле карты, окно впереди, звук. Ничего не введено.
- [ ] Модуль `applepay`: способ выбран, окно впереди, звук. Финальная кнопка не нажата.
- [ ] Очередь оплаты выводит окна по одному.
- [ ] В логах нет токенов, cookie и полных контактов.

---

## 12. Установка и запуск (macOS)

1. `npm i && npm run build` → папка `dist/`.
2. Chrome → создать профили `Drop 1 … Drop N` (имя папки профиля видно в `chrome://version` → «Путь к профилю»).
3. В каждом профиле: `chrome://extensions` → «Режим разработчика» → «Загрузить распакованное» → `dist/`. Закрепить иконку.
4. В каждом профиле: Options → вставить общий конфиг, указать свой `profileId`.
5. (Опционально) хаб: `node hub/server.mjs`, открыть дашборд `http://127.0.0.1:8765`.
6. В каждом профиле: Popup → **Prepare** → проверить зелёный статус.
7. В день дропа: `scripts/open-profiles.command` → в каждом профиле Popup → **Start**.

После изменения кода: `npm run build`, затем в `chrome://extensions` нажать «Обновить» в каждом профиле.

---

## 13. Чек-лист дня дропа (16.10)

| Время (Дубай) | Действие |
|---|---|
| за день | T1–T7, Clean bag. Проверить Apple Pay (T5) |
| 14:30 | VPN выключен. Chrome обновлён, не просит перезапуск. Mac на зарядке, сон выключен (`caffeinate -d` в Терминале) |
| 15:00 | Хаб запущен (если нужен). Во всех профилях **Prepare** → зелёный. Корзины пустые |
| 15:50 | Во всех профилях **Start**. В дашборде/popup наблюдатель пишет `COMING_SOON`, вкладки в `ARMED` |
| 15:59 | Вкладки переходят в `PRE_RELOAD` |
| 16:00–16:10 | OPEN → Add to Bag → чекаут. На уведомление «Заказ X готов» — оплатить в выведенном окне (карта или Apple Pay). Затем «Следующий» |
| после | Номера `W…` в дашборде, popup и на почтах получателей. Clean bag во всех профилях |

---

## 14. Чего не делать

- Не собирать URL Add to Bag и тела `checkoutx` вручную — только клики в странице.
- Не снимать `disabled` с кнопок, не вызывать функции сайта, не перехватывать `fetch`/XHR страницы.
- Не уходить со страницы Add to Bag до `step=attach` или `/shop/bag`.
- Не вводить карту и CVV, не нажимать Place Order / Pay.
- Не использовать `chrome.debugger`, подмену отпечатков и UA, прокси-ротацию, решение капчи.
- Не логировать токены, cookie, платёжные данные, полные контакты.
- Не превышать лимиты нагрузки §7.1.

---

## 15. Открытые вопросы

1. Разметка баннера выбора страны (T4).
2. Принимает ли Apple программный `.click()` на Add to Bag, Check Out, Guest (T3). От этого зависит, нужен ли режим ассистента.
3. Принимает ли приложение `setSelect` для города и окна слота (T7).
4. Селекторы Review и путь Apple Pay в Chrome (T5).
5. Привязаны ли «волны» Apple к сессии: дают ли что-то вкладки одного профиля или нужны только профили (T2/T6).
6. Сколько Apple держит выбранный слот до оплаты.
7. Будет ли у Duo на старте выбор слота (у 18 Pro 28.09 был).
8. Лимит на покупателя для Duo в ОАЭ.

---

## Приложение A. Парт-номера iPhone 18 Pro / Pro Max (AE)

| Память | Цвет | 18 Pro 6.3" | 18 Pro Max 6.9" |
|---|---|---|---|
| 256GB | black | MJR54AH/A | MJX54AH/A |
| 256GB | silver | MJR64AH/A | MJX64AH/A |
| 256GB | burgundy | MJR74AH/A | MJX74AH/A |
| 256GB | glacier | MJR84AH/A | MJX84AH/A |
| 512GB | black | MJR94AH/A | MJX94AH/A |
| 512GB | silver | MJRC4AH/A | MJXA4AH/A |
| 512GB | burgundy | MJRD4AH/A | MJXC4AH/A |
| 512GB | glacier | MJRE4AH/A | MJXD4AH/A |
| 1TB | black | MJRF4AH/A | MJXE4AH/A |
| 1TB | silver | MJRG4AH/A | MJXF4AH/A |
| 1TB | burgundy | MJRH4AH/A | MJXG4AH/A |
| 1TB | glacier | MJRJ4AH/A | MJXH4AH/A |
| 2TB | black | MJRK4AH/A | MJXJ4AH/A |
| 2TB | silver | MJRL4AH/A | MJXK4AH/A |
| 2TB | burgundy | MJRM4AH/A | MJXL4AH/A |
| 2TB | glacier | MJRN4AH/A | MJXM4AH/A |

URL: `/ae/shop/buy-iphone/iphone-18-pro/{6.3|6.9}-inch-display-{cap}-{color}`

## Приложение B. Что переиспользовать из v1

Из архива `apple-drop-bot.zip`:
- `test/mock-server.js` — макет сайта: задержка Add to Bag, заглушка, занятый слот, магазин без наличия;
- `src/selectors.js` — селекторы;
- `src/watcher.js` — логика JSON-наблюдателя;
- `src/worker.js` — порядок шагов чекаута и обработка ошибок.

Код Playwright (`bot.js`, запуск браузеров) в расширении не нужен.
