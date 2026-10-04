# Apple Drop Assistant — что сделано и как это работает (handoff)

Документ для Claude или разработчика, который будет писать инструкцию для бота-покупателя на apple.com/ae. Здесь собрано всё, что выяснили и реализовали в Chrome-расширении «Apple Drop Assistant» за 28.09–30.09.2026: как устроен сайт Apple по шагам, какие селекторы и тексты работают, что подтверждено живыми тестами, какие сбои бывают и как на них реагировать, где проходит граница между машиной и человеком.

Исходники: репозиторий `georgii-korzion/applebot`, ветка `claude/modest-goldberg-8ufyyx`. Исходное ТЗ — `docs/SPEC.md` (v3), исследование предзаказа 18 Pro — `docs/RESEARCH-iphone18-preorder.md`, инструкция для живых тестов — `test-setup/README.md`.

---

## 0. Коротко

- **Цель:** предзаказ iPhone Duo на apple.com/ae, старт **16.10.2026 в 16:00 по Дубаю**, гостевой чекаут, самовывоз из магазина Apple в ОАЭ.
- **Что умеет расширение:** ждёт открытия продаж без лишней нагрузки на сайт, переживает закрытый магазин и очередь, жмёт Add to Bag без «Page Not Found», чистит корзину до одной позиции, проходит Guest → самовывоз (магазин, дата, окно) → контакты → оплата, заполняет карту и адрес плательщика, ставит галочку условий, нажимает Review, для Apple Pay жмёт кнопку оплаты, для карты (по флагу) жмёт Place Order один раз, ловит номер заказа `W…`, сохраняет запись о заказе.
- **Что всегда делает человек:** подтверждает Apple Pay на телефоне и подтверждает оплату картой в приложении банка (3-D Secure).
- **Масштаб:** несколько вкладок в профиле Chrome и несколько профилей, связанных локальным хабом; один победитель на заказ, остальные в запасе.
- **Проверено:** 16 e2e-сценариев на мок-сервере в настоящем Chromium + 13 юнит-тестов, все зелёные. Живые прогоны на iPhone 18 Pro (уже в продаже) доходили до Review.

---

## 1. Контекст дропа

| Что | Значение |
|---|---|
| Сайт | `https://www.apple.com/ae/` (чекаут уходит на `https://secureN.store.apple.com/ae/...`, N меняется: 7, 9…) |
| Старт | 16.10.2026 16:00 (UTC+4) |
| Товар | iPhone Duo 7.6", 256 GB / 512 GB / 1 TB / 2 TB, цвета Star White / Night Sky |
| Тестовый товар | iPhone 18 Pro 256 GB Black `MJR54AH/A` (уже продаётся, цена AED 5 099) |
| Покупка | гостевая (без Apple Account), самовывоз, 1 штука на заказ |
| Как прошёл прошлый дроп (18 Pro, 12.09) | магазин закрыли за часы до старта; после старта несколько минут был недоступен; вероятно очередь вместо рефреш-долбёжки; на чекауте «unexpected error», лечилось повтором; были дубли заказов; квоты в ОАЭ ушли меньше чем за 20 минут |

### 1.1 Парт-номера (AE)

iPhone Duo (`/ae/shop/buy-iphone/iphone-duo/7.6-inch-display-<cap>-<color>`):

| Память | Star White | Night Sky |
|---|---|---|
| 256 GB | `MK244AH/A` | `MK254AH/A` |
| 512 GB | `MK264AH/A` | `MK274AH/A` |
| 1 TB | `MK284AH/A` | `MK294AH/A` |
| 2 TB | `MK2A4AH/A` | `MK2C4AH/A` |

iPhone 18 Pro / Pro Max: `/ae/shop/buy-iphone/iphone-18-pro/6.3-inch-display-<cap>-<color>` (Pro Max — `6.9-inch-display`). Полный список в `src/shared/parts.ts`, пример: `MJR54AH/A` = 18 Pro 256 GB Black.

Пример прямой ссылки: `https://www.apple.com/ae/shop/buy-iphone/iphone-duo/7.6-inch-display-256gb-night-sky` — сразу выбирает модель, цвет и память.

### 1.2 Магазины ОАЭ

| Код | Магазин | Город в чекауте |
|---|---|---|
| R597 | Apple Dubai Mall | Dubai |
| R596 | Apple Mall of the Emirates | Dubai |
| R706 | Apple Al Maryah Island | Abu Dhabi |
| R595 | Apple Yas Mall | Abu Dhabi |
| R785 | Apple Al Jimi Mall (Al Ain) | Al Ain |

---

## 2. Граница автоматизации

ТЗ v3 останавливало автоматику перед оплатой. Владелец по итогам живых тестов расширил её; таблица — текущее состояние.

| Действие | Кто | Когда решено |
|---|---|---|
| Ожидание старта, рефреши, Add to Bag, корзина, Check Out, Guest | расширение | ТЗ v3 |
| Самовывоз: город, магазин, дата, окно | расширение | ТЗ v3 |
| Контакты получателя | расширение | ТЗ v3 |
| Выбор способа оплаты | расширение | ТЗ v3 |
| Ввод карты (номер, срок, CVV) | расширение, если карта задана в настройках | 29.09 |
| Billing Address (адрес плательщика) | расширение | 30.09 |
| «Review Your Order» | расширение (`autoReview`, по умолчанию вкл.) | 29.09 |
| Галочка Terms & Conditions на Review | расширение | 30.09 |
| Кнопка Apple Pay на Review («Continue with Pay») | расширение пробует; если браузер не открыл лист — подсветка, жмёт человек | 29.09 |
| Подтверждение Apple Pay (QR/телефон) | **человек** | всегда |
| «Place Order» при оплате картой | расширение **один раз**, если включён `autoPlaceOrder` (по умолчанию выкл.); иначе человек | 30.09 |
| Подтверждение банка (3-D Secure в приложении) | **человек** | всегда |

Логика владельца: «Place Order» при карте — не финальное подтверждение, банк всё равно спрашивает в приложении. Оговорка, которую расширение показывает при старте: если банк подтверждения не запросит, заказ оформится без человека.

Жёсткие запреты (из ТЗ, соблюдаются везде):
- не обходить защиту Apple: никакой подмены отпечатков/User-Agent, ротации прокси, решения капч, подделки `atbtoken` / `x-aos-stk` / Apple Shield (`shldVerify`), никакого `chrome.debugger`;
- не строить URL Add to Bag руками, только клик по кнопке;
- не генерировать личности; получатель — реальный человек с документом;
- не писать в логи токены, cookie, данные карты, полные контакты.

---

## 3. Что подтверждено, а что нет

| Факт | Уровень | Источник |
|---|---|---|
| JSON `fulfillment-messages` до старта отдаёт `isBuyable:false, reason:"COMING_SOON"` | снято вживую (28.09, Duo) | ТЗ §3.0 |
| Селекторы страницы товара, корзины, Guest, Fulfillment, контактов, выбора оплаты (`data-autom`) | сняты вручную 28.09; живой прогон 18 Pro 29–30.09 прошёл все эти шаги | ТЗ §3.1–3.8, живые тесты |
| Цепочка Add to Bag: 200 на URL с `add-to-cart=` → `step=attach` → корзина | снято вручную 28.09 | ТЗ §3.2 |
| Слот выглядит как «September 30 10:15 – 10:30», окна по 15 минут | живой прогон 30.09 | лог владельца |
| От старта до Billing на живом 18 Pro — около 36 с (одна вкладка, `openAt` в прошлом) | живой прогон 30.09 | лог владельца |
| Блок карты на Billing появляется **через несколько секунд** после выбора «Credit or Debit Card» | живой прогон 30.09 | наблюдение владельца |
| Billing Address при карте обязателен: Country/Region (UAE, фиксировано), Title (select, необяз.), First Name, Last Name, Suffix (opt.), Street Address, Area, Town (optional), City (select). Ошибка «Please complete this mandatory field.» | живой прогон 30.09 | скриншот |
| Подпись Apple Pay на Billing — логотип-картинка + «Pay»; карта — «Credit or Debit Card / Visa, Mastercard, AMEX» | живой прогон 30.09 | скриншот |
| На Review есть чекбокс «I have read, understand, and agree to the Terms & Conditions…»; без него «Please read and accept the terms & conditions of this order.» | живой прогон 30.09 | скриншот |
| Кнопка Apple Pay на Review — «Continue with [логотип] Pay»; программный клик до сайта доходит (сайт провалидировал форму и показал ошибку про галочку) | живой прогон 30.09 | скриншот |
| `data-autom` полей Billing Address | **догадка** по аналогии с контактами (`form-field-firstName`, `form-field-street`…); есть запасной поиск по подписям | — |
| Открывает ли программный клик лист Apple Pay в Chrome | **не проверено** (тест T10) | — |
| Что происходит после «Place Order» с картой (3-D Secure: окно Apple или страница банка) | **не проверено** (тест T12) | — |
| Разметка баннера выбора страны | **не снята** (тест T4); поиск по тексту | — |
| Текст и вид страницы очереди / заглушки на apple.com/**ae** | **не снят**; распознавание по общим признакам и текстам с US-сайта | исследование |
| Принимает ли Apple выбор города/окна через программный сеттер | частично: живой прогон выбрал окно; смена города — тест T7 | — |
| Есть ли окно самовывоза в день дропа | **не известно** (T8) | — |
| Точный текст ошибки «окно занято» | **не снят** (T9); регулярка по «no longer available / not available for / Please select/choose» | — |

---

## 4. Сквозной сценарий покупки

Для каждого шага: как узнать страницу, что делать, как понять успех, что делать при сбое. Селекторы даны основные; запасные пути — в §7.

### 4.0 Подготовка профиля (Prepare, за день до старта)

1. Открыть `/ae/` — проверить, что нет баннера выбора страны (если есть — выбрать United Arab Emirates).
2. Открыть `/ae/shop/bag` — удалить всё из корзины.
3. Открыть страницу цели — проверить, что URL на `/ae/`, цены в AED, баннера нет; до старта на месте Add to Bag стоит неактивная «Continue» (`[data-autom="continueButton"]`).
4. Если страница товара пустая — магазин уже закрыт; это не ошибка, Start всё равно можно жать.

Требования к окружению: VPN выключен, язык Chrome English, часовой пояс Дубай, Mac на зарядке без сна (`caffeinate -d`), окна не сворачивать (Chrome тормозит скрытые вкладки).

### 4.1 Ожидание открытия

**Главный сигнал — JSON, а не рефреш страницы:**

```
GET https://www.apple.com/ae/shop/fulfillment-messages
    ?fae=true&pl=true&mts.0=regular&mts.1=compact
    &parts.0=MK254AH/A&parts.1=MK244AH/A&searchNearby=true&store=R597
```

- До 3 партов в запросе (`parts.0..2`).
- Запрос из страницы apple.com — same-origin, с cookie.
- Открыто, если `body.content.deliveryMessage["<PART>"].compact.buyability.isBuyable === true` (или в `regular`).
- Самовывоз: `body.content.pickupMessage.stores[].partsAvailability["<PART>"].pickupDisplay` = `available` / `unavailable` / `ineligible`.
- Опрос раз в ~1,2 с ±30 %, не чаще раза в секунду.
- Запасной сигнал: в HTML страницы товара появилась `data-autom="add-to-cart"`, пропала `data-autom="continueButton"` и строка `Pre-order starting` (проверяется реже: раз в ~30 с задолго до старта, раз в ~6 с в последнюю минуту).
- Если JSON отвечает не-JSON или ошибкой — магазин закрыт; продолжать опрос.

**Роли вкладок:** одна вкладка-наблюдатель опрашивает JSON и не перезагружается; остальные («гонщики») перезагружаются по фазам. Если наблюдатель заторможен браузером, опрос перехватывает service worker.

**Фазы (от `openAt`):**

| Фаза | Когда | Вкладка на странице товара | Закрытый магазин / пустая страница |
|---|---|---|---|
| armed | до старта − 60 с | не рефрешит, ждёт фазу pre | рефреш раз в ~30 с |
| pre | последняя минута | рефреш раз в ~3 с ±30 % (наблюдатель — нет) | рефреш раз в ~3 с |
| post | после старта или сигнала OPEN | рефреш раз в ~1,5 с ±30 %, не чаще 1,5 с | рефреш раз в ~1,5 с, без ожидания |

**При сигнале OPEN:** все вкладки перезагружаются со случайной задержкой 0–500 мс (чтобы не бить одновременно). Страница, загруженная уже после OPEN, второй раз не перезагружается.

**Закрытый магазин перед дропом** (видели на 18 Pro): текст «We love that early energy. Almost ready for you. Pre-order begins at … See you soon», «We'll be back», пустая страница, 404, 503, редирект на заглушку (в том числе вне `/ae/`). Реакция: вкладка не уходит, рефрешит цель по фазам, пока не пустит; уведомление «Apple Store закрыт» и «открылся».

**Очередь Apple** (признаки: «in line», «your turn», «don't refresh», «waiting room», «estimated wait» и т.п., или `<meta http-equiv="refresh">`, и при этом на странице меньше 3 элементов `data-autom`): **не перезагружать** — рефреш может сбросить место. Ждать, пока страница сама пустит, до 90 с, потом один рефреш.

**Заглушка нагрузки** («so are we», «Almost there», «Be right back», «busy right now», «high demand», «isn't available right now», HTTP 503/541): рефреш с джиттером; после старта не реже раза в 4 с (Apple пускает волнами); если у заглушки есть meta refresh — дать ей обновиться самой.

### 4.2 Страница товара → Add to Bag (самое хрупкое место)

Признак: путь `/ae/shop/buy-iphone/<family>/<slug>`, нет `step=attach`.

1. **Гидратация.** Под нагрузкой форма появляется не сразу. Если разметка товара уже пришла (есть `PRODUCT_SELECTION_BOOTSTRAP` / `fulfillmentBootstrap` в скриптах), ждать кнопку до 12 с; если страница пустая — 1 с и считать магазин закрытым.
2. Проверить, что в форме нужный товар: скрытое поле `input[name="product"]` = парт цели. Иначе перейти на URL цели.
3. **No trade-in:** `[data-autom="choose-noTradeIn"]` (radio спрятан — кликать по `<label>`). Ждать сетевой запрос `/ae/shop/updateSummary` до 5 с. Если секции нет — пропустить, не ждать.
4. **No AppleCare:** `[data-autom="noapplecare"]` (по label). Ждать запрос `/ae/shop/updateSummary?…acpart=none` до 5 с.
5. **Ждать, пока Add to Bag станет активной сама** (`[data-autom="add-to-cart"]`, до 12 с). `disabled` руками не снимать.
6. Записать «клик сделан» **до** клика (результат увидит уже следующая загрузка страницы).
7. Клик по кнопке. URL с `atbtoken` строит JS сайта из cookie `as_atb` — **не строить его самому**.
8. **Не уходить со страницы**, пока сайт сам не перейдёт. Цепочка успеха: 200 на `…?product=…&acpart=none&atbtoken=…&add-to-cart=add-to-cart` → навигация на `/ae/shop/buy-iphone/<family>?product=<part>&step=attach`. Уход раньше теряет товар (корзина окажется пустой).

Исходы следующей загрузки:

| Что открылось | Значит | Реакция |
|---|---|---|
| `step=attach` или `/ae/shop/bag` | успех | в корзину |
| «Page Not Found» (title `Page Not Found - Apple`, «can't be found», 404) | запрос отклонён (ATB_404) | пауза ~1,5 с, снова URL цели; 5 раз подряд — стоп с диагностикой |
| заглушка / закрыто | нагрузка | бэкофф, повтор |
| очередь | Apple держит в очереди | ждать до 90 с, не уходить |
| URL с `add-to-cart=` и 200 | запрос принят | ничего не делать, ждать `step=attach` до 15 с |
| снова страница товара без перехода | клик не сработал | повтор |
| ничего за 15 с | таймаут | повтор с URL цели |

После 3 неудач подряд на шаге включается **режим ассистента**: кнопка подсвечивается, окно выходит вперёд со звуком, человек жмёт сам (засчитывается только настоящий клик, `event.isTrusted`), дальше автоматика продолжает.

### 4.3 `step=attach` → корзина `/ae/shop/bag`

`step=attach` — допродажа аксессуаров, сразу перейти на `/ae/shop/bag`.

В корзине:
- ждать позиции `[data-autom="bag-item-name"]` или текст «Your bag is empty» до 10 с; если «пусто» — подождать ещё 2 с (позиции догружаются позже);
- оставить одну позицию нужной модели (сначала точное совпадение «модель + память + цвет», иначе «модель + память»), остальные удалить кнопкой `[data-autom="bag-item-remove-button"]`;
- количество `[data-autom="item-quantity-dropdown"]` = 1;
- сумма — `[data-autom="bagtotalvalue"]`;
- лимит Apple «maximum of N … per customer» — записать в лог.

**Пустая корзина после Add to Bag** (было 12.09 у многих — сломанная сессия корзины): повторить Add to Bag; 3 раза подряд — стоп и уведомление (помогает открыть корзину руками или другой профиль).

**Check Out:** `[data-autom="checkout"]`, обычный `.click()` работает. Если URL не сменился за 5 с — повтор; после нескольких неудач — ассистент. Ведёт на `https://secureN.store.apple.com/ae/shop/signIn?ssi=…`.

### 4.4 Вход: Continue as Guest

`[data-autom="guest-checkout-btn"]`, ждать до 12 с, `.click()` работает, ждать смену URL 6 с. Нет кнопки или не срабатывает — назад в корзину и снова Check Out. Модуль Apple Shield и `init_data` на этой странице не трогать.

Успех: `/ae/shop/checkout?_s=Fulfillment-init`.

### 4.5 Fulfillment: самовывоз, магазин, дата, окно (`_s=Fulfillment`)

Чекаут — одностраничное приложение: шаги меняются через `history`, без перезагрузки. Текущий шаг — параметр `_s` (`Fulfillment`, `PickupContact`, `Shipping`, `Billing`, `Review`, с суффиксом `-init` или без). Нужно следить за сменой URL (расширение опрашивает `location.href` раз в 150 мс).

1. Ждать страницу до 12 с.
2. «I'll pick it up»: `button.rc-segmented-control-button` с текстом про pickup; выбранная имеет класс `rc-segmented-control-selected`.
3. Город: `select[data-autom="form-field-city"]` (по умолчанию Dubai). Выбор по тексту опции. Если программный выбор не принят — ассистент (человек выбирает сам).
4. Список магазинов: `input[name="store-locator-result"]`, ждать до 10 с. Магазин ищется по `value="R597"`, запасной путь — по названию в подписи. Карточка с «Currently unavailable» / «Not available» или `disabled` — пропустить.
5. Магазины перебираются в порядке из конфига.
6. Дата: `input[name="bartPickupDateSelectorButtonGroup"]`, `value` = день месяца. Нужный день из конфига или первая доступная.
7. Окно: `select[data-autom="pickup-availablewindow-dropdown"]`, опции `value="28-19:15-19:30"`, первая пустая. Окна упорядочиваются: сначала попадающие в «после HH:MM / до HH:MM» из конфига, потом остальные, порядок сайта внутри групп.
8. «Continue to Pickup Details»: `[data-autom="fulfillment-continue-button"]`.

Серверу уходит `POST /ae/shop/checkoutx/fulfillment?_a=continueFromFulfillmentToPickupContact` с `timeSlotId` и `signKey`, которые выдаёт сервер — **выбирать только через интерфейс**, запрос не собирать.

**Как понять, чем кончился Continue** (важно: Apple может показать ту же ошибку второй раз, и DOM не изменится):
- сменился URL на следующий шаг → успех;
- завершился XHR `/shop/checkoutx` (видно через PerformanceObserver) → подождать 400 мс и прочитать ошибку;
- кнопка ушла в `disabled` и вернулась → запрос завершён;
- появился новый текст ошибки;
- ничего за 15 с → таймаут.

**Классы ошибок:**

| Тип | Признак | Реакция |
|---|---|---|
| общая | «unexpected error», «something went wrong», «try again», «temporarily unable», «sorry» | повторить **то же** окно до 2 раз, не отдавать хороший слот |
| слот | «no longer available», «not available for», «Please select», «Please choose» | следующее окно (до 4 на магазин), потом следующий магазин |
| валидация | «Please enter/provide/check/complete…», «is required», «invalid» | стоп, нужен человек |

Нет самовывоза ни в одном магазине: фолбэк доставки (если включён), Apple Pay Express из корзины (если разрешён) или стоп с уведомлением.

Успех: `_s=PickupContact`.

### 4.6 Контакты получателя (`_s=PickupContact`)

| Поле | Селектор |
|---|---|
| «I'll pick it up» (сам) | `[data-autom="selfPickup"]` |
| Имя | `[data-autom="form-field-firstName"]` |
| Фамилия | `[data-autom="form-field-lastName"]` |
| Email | `[data-autom="form-field-emailAddress"]` |
| Мобильный (обязателен, `05XXXXXXXX`) | `[data-autom="form-field-mobilePhone"]` |
| «Continue to Payment» | `[data-autom="continue-button-label"]` |

Поля — React-инпуты, заполнять через нативный сеттер + события (§6). Общая ошибка — повтор до 2 раз; ошибка валидации — состояние «нужен человек», уведомление, вкладка ждёт до 10 минут, пока человек поправит поле и сам нажмёт Continue, после чего автоматика продолжает.

Успех: `_s=Billing`.

### 4.7 Оплата (`_s=Billing`, «How do you want to pay?»)

Способы: `[data-autom="checkout-billingOptions-CREDIT"]` (карта), `[data-autom="checkout-billingOptions-APPLE_PAY"]` (Apple Pay). Radio спрятаны, кликать по подписи. Ждать до 12 с.

**Apple Pay:** выбрать radio. Если Apple Pay нет — фолбэк на карту (`applePayFallback: "manual"`) или стоп.

**Карта:**
1. Выбрать «Credit or Debit Card».
2. **Ждать поля карты до 10 с** (`timing.cardWaitMs`) — блок грузится с задержкой. Если через 3 с полей нет и radio не выбран — кликнуть ещё раз. В логе: «поля карты появились через N с».
3. Заполнить:

| Поле | Селектор | Запасной путь |
|---|---|---|
| Номер | `[data-autom="card-number-input"]` | `autocomplete="cc-number"`, name `cardNumber`, подпись «card number» |
| Срок `MM/YY` | `[data-autom="expiration-input"]` | `cc-exp`, «expir», «MM/YY» |
| CVV | `[data-autom="security-code-input"]` | `cc-csc`, «cvv/cvc/security code» |
| Имя на карте | `[data-autom="form-field-nameOnCard"]` | `cc-name` (на живом AE не встречалось) |

   После ввода сравнить цифры в поле с ожидаемыми; в лог — только `****1234` и список заполненных полей.
4. **Billing Address** (только внутри блока с заголовком «Billing Address»):

| Поле | Обязательно | Откуда значение | Селектор (догадка) → запасной путь |
|---|---|---|---|
| Title | нет | `billing.title` | `[data-autom="form-field-title"]` → select с name `title` |
| First Name | да | `billing.firstName` или имя получателя | `form-field-firstName` → name/autocomplete/подпись |
| Last Name | да | `billing.lastName` или фамилия получателя | `form-field-lastName` → … |
| Street Address | да | `billing.street` или адрес доставки | `form-field-street` → `address-line1`, подпись «Street Address» |
| Area | да | `billing.area` или адрес доставки | `form-field-street2` → name `area`, `address-line2`, подпись «Area» |
| Town | нет | `billing.town` | `form-field-street3` → name `town`, подпись «Town» |
| City | да | `billing.city` (Dubai…) | `form-field-city` (select) → выбор по тексту опции |

   Без адреса «Review Your Order» отвечает «Please complete this mandatory field».
5. **Если поля карты так и не появились за 10 с:** при `cardFallback: "applepay"` (по умолчанию) — переключиться на Apple Pay и идти дальше как Apple Pay; при `null` — плашка «введи карту сам».

После этого вкладка встаёт в **очередь оплаты** (впереди всегда одна вкладка, чтобы человек не метался между окнами). Когда подходит её очередь — окно выходит вперёд, звук, уведомление.

**Review Your Order** (`[data-autom="continue-button-review"]`, при `autoReview: true`): ждать активности до 4 с, кликнуть, ждать `_s=Review` до 15 с. Не открылся — показать текст ошибки («Please complete this mandatory field» и т.п.), дальше человек.

### 4.8 Review (`_s=Review`)

1. **Галочка Terms & Conditions — обязательно до любого клика по оплате.** Поиск: `[data-autom*="terms"] input[type=checkbox]` → checkbox с name/id `terms`/`agree` → checkbox, у которого подпись или соседний текст содержит «terms|agree». Input спрятан (`opacity:0`) — кликать по input, проверить `checked` за 1,5 с, иначе кликнуть по label. Не получилось — плашка «поставь галочку сам».
2. **Apple Pay** («Continue with [логотип] Pay»): поиск `[data-autom="apple-pay-button"]` → `apple-pay-button` → `button[data-autom*="apple-pay"]` → `aria-label*="Apple Pay"` → класс `applepay` → текст `^(pay with |continue with |buy with )?(apple )?pay$`. Клик один раз. Через 900 мс:
   - если сайт показал ошибку про условия — поставить галочку и кликнуть ещё раз (один повтор);
   - если страница потеряла фокус (`document.hasFocus() === false`) — открылся лист Apple Pay, человек сканирует QR телефоном;
   - если фокус на месте — Chrome не открыл лист от программного клика (нужен настоящий жест пользователя), подсветить кнопку и ждать клика человека.
3. **Place Order при карте** (только `autoPlaceOrder: true`): кнопка `[data-autom="continue-button-placeorder"]` → `data-autom*="placeorder"` → текст «Place Order». Сначала галочка, потом **один** клик. Флаг «нажато» хранится в состоянии вкладки и переживает перезагрузку — второго клика не будет никогда. Единственный повтор — если ошибка именно про галочку (заказ не отправлялся). Любая другая ошибка после клика — только в лог и на плашку: **сначала проверить почту и номер заказа** (12.09 у людей были дубли). Дальше человек подтверждает оплату в приложении банка. Редиректы банка вне `/ae/` в чекауте расширение не трогает.
4. Без `autoPlaceOrder` — плашка «нажми Place Order», расширение только наблюдает.

### 4.9 Подтверждение

Номер заказа ловится наблюдателем DOM: регулярка `\bW\d{9,11}\b` + текст «thank you / order number», на любой странице чекаута. Дальше: состояние ORDERED, уведомление «Заказ оформлен ✅», запись о заказе, очередь оплаты переходит к следующей вкладке.

Если оплата не подтверждена за 10 минут (`manualPayTimeoutSec`) — состояние PAY_TIMEOUT и уведомление.

---

## 5. Сводка нештатных ситуаций

| Ситуация | Как распознать | Реакция |
|---|---|---|
| Магазин закрыт до старта | тексты закрытия (§4.1), пустая страница, 404, редирект в т.ч. вне `/ae/` | рефреш цели по фазам, уведомления «закрыт/открылся» |
| Магазин недоступен минуты после старта | то же | рефреш ~1,5 с сразу со старта |
| Очередь | тексты очереди или meta refresh, мало `data-autom` | не трогать до 90 с |
| Заглушка нагрузки | «Almost there», «so are we», 503/541 | рефреш, после старта ≤ 4 с |
| Баннер выбора страны | «Choose another country or region», «You're viewing» вне футера | выбрать United Arab Emirates / Continue; 3 раза подряд — стоп «проверь VPN»; после старта узкий баннер над готовой формой игнорировать |
| Вкладку увело с `/ae/` | URL вне `/ae/` | вернуть на цель по фазам; 3 раза — уведомление |
| 404 на Add to Bag | title «Page Not Found», URL с `add-to-cart=` | повтор через ~1,5 с, 5 подряд — стоп с диагностикой |
| Пустая корзина после Add to Bag | «Your bag is empty» после 2 с ожидания | повтор, 3 подряд — стоп |
| Лишнее в корзине | несколько `bag-item-name` | удалить, оставить одну позицию, количество 1 |
| Ошибка общего вида на чекауте | «unexpected error», «try again»… | повтор того же действия до 2 раз |
| Окно занято | «no longer available»… | следующее окно / магазин |
| Ошибка валидации | «Please enter…», «is required» | стоп, человек поправляет, автоматика продолжает |
| Нет самовывоза | все магазины «unavailable» | доставка / Apple Pay Express / стоп |
| Медленный блок карты | нет полей карты | ждать 10 с, потом Apple Pay |
| Нет Billing Address | «Please complete this mandatory field» на Review Your Order | заполнить адрес (если задан в настройках), иначе плашка |
| Нет галочки условий | «Please read and accept the terms & conditions of this order.» | поставить галочку, повторить клик один раз |
| Ошибка после Place Order | любой текст ошибки | **не повторять**, проверить почту/номер заказа |
| Ночные работы Apple | 404/503 на чекауте | спокойный рефреш ≥ 5 с |
| Вкладку закрыли / победитель упал | событие закрытия, STUCK | через хаб заказ переходит запасному профилю (TAKEOVER) |

---

## 6. Как действовать на странице, чтобы сайт принял

Сайт Apple — React. Простое `el.value = x` он не видит.

- **Текстовое поле:** `focus()` → нативный сеттер `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value)` → события `input`, `change`, `blur`, `focusout` (bubbles). После — проверить `el.value` и `aria-invalid`.
- **Select:** нативный сеттер `HTMLSelectElement.prototype.value` → `input` + `change`. Проверить, что значение осталось. Если сайт сбросил — нужен человек.
- **Radio:** настоящие input спрятаны; кликать по `<label>` (`input.labels[0]` или ближайший `label`). Проверить `checked`.
- **Checkbox условий:** клик по input, проверка `checked`, запасной вариант — клик по label.
- **Кнопки:** `scrollIntoView({block:'center'})` + `.click()`. Для Add to Bag, Check Out, Guest, Continue программный клик работает.
- **Apple Pay:** лист оплаты браузер открывает только на настоящий жест пользователя — это правило Chrome, не защита Apple. Программный клик может не открыть лист.
- **Ожидание сети без перехвата:** PerformanceObserver на resource-записи (`/shop/updateSummary`, `/shop/checkoutx`).
- **Смена шага:** опрос `location.href` (pushState не даёт событий в изолированном мире content script).
- **Ждать, а не спешить:** гидратация до 12 с под нагрузкой, блок карты до 10 с, корзина до 10 с + 2 с.
- **Не уходить со страницы** между кликом Add to Bag и `step=attach`.

---

## 7. Устойчивость к смене селекторов

Каждый элемент описан набором: основной селектор (`data-autom` из ТЗ) → запасные селекторы → поиск по тексту кнопки / подписи radio / атрибутам поля (`name`, `autocomplete`, `placeholder`, `aria-label`, `id`, текст `<label>`). Если сработал запасной путь, это пишется в лог один раз на страницу («addToBag←запасной селектор …», «guest←текст …») — после дропа видно, что поменялось. Тест `renamed-selectors` переименовывает все `data-autom` на моке, и сценарий всё равно доходит до Billing (28 срабатываний запасных путей).

Текстовые якоря, по которым ищутся кнопки:

| Элемент | Текст |
|---|---|
| Add to Bag | `^add to bag$` |
| No trade-in | `^no trade.?in` |
| No AppleCare | `^no applecare` |
| Check Out | `^check ?out$` |
| Remove | `^remove$` |
| Guest | `continue as guest`, `guest checkout` |
| Continue (fulfillment) | `^continue to (pickup|shipping)` |
| Continue to Payment | `^continue to payment` |
| I'll pick it up | `^i.ll pick it up`, `myself` |
| Карта | `credit`, `debit`, `card` |
| Apple Pay radio | `apple ?pay`, `^pay$` |
| Review | `^review your order` |
| Apple Pay кнопка | `^(pay with |continue with |buy with )?(apple )?pay$` |
| Place Order | `^place (your )?order$` |
| Условия | `terms`, `agree` |

Все тексты и регулярки — `src/shared/selectors.ts`, все спецификации поиска — `src/content/find.ts`.

---

## 8. Много вкладок и профилей

**Один профиль Chrome = одна сессия = одна корзина.** Вкладки одного профиля делят корзину, поэтому:

- Add to Bag в профиле жмёт только та вкладка, которая получила **лок** от service worker (лок на время ожидания ответа, до 15 с, в режиме ассистента до 2 минут).
- Первая вкладка с подтверждённой корзиной — **победитель**; остальные вкладки профиля останавливаются (STOPPED). Если корзина победителя потерялась — остановленные возвращаются в гонку.
- Победителя делают активной вкладкой окна (видимые вкладки Chrome не тормозит); вкладкам гонки отключена автовыгрузка (`autoDiscardable:false`).

**Несколько профилей связывает хаб** — маленький локальный WebSocket-сервер (`npm run hub`, `ws://127.0.0.1:8765`, дашборд там же по HTTP):

| Сообщение | Что делает |
|---|---|
| REGISTER | профиль сообщает заказ, приоритет, цели |
| WATCHER | хаб назначает один профиль-наблюдатель на всех |
| OPEN | первый увидевший открытие сообщает всем |
| WIN_REQ → WIN / LOSE | первый профиль с корзиной ведёт заказ, остальные STANDBY (держат товар 90 с) |
| PAY_READY → CLEAN | победитель на оплате — запасные чистят корзины (лимит «1 на покупателя») |
| FAILED → WIN (takeover) | победитель упал — заказ переходит следующему запасному |
| PAY_TURN / PAY_DONE / NEXT | очередь оплаты между профилями: вперёд выходит одно окно за раз |
| ORDERED | номер заказа, запись в общую таблицу |

Без хаба один профиль работает полностью сам. Хаб не ответил за 3 с — профиль продолжает сам.

---

## 9. Конфиг (полная схема)

Хранится в `chrome.storage.local` профиля, редактируется на странице настроек или JSON-ом. `profileId` хранится отдельно и не перетирается импортом общего JSON.

```jsonc
{
  "profileId": "drop-1",
  "hubUrl": "",                              // "ws://127.0.0.1:8765" или пусто
  "openAt": "2026-10-16T16:00:00+04:00",
  "mode": "auto",                            // "assist" — критичные кнопки жмёт человек
  "baseUrl": "https://www.apple.com",        // мок — только в dev-сборке: http://127.0.0.1:4777
  "orders": [{
    "id": "A",
    "priority": 1,                           // порядок в очереди оплаты
    "profiles": ["drop-1"],                  // какие профили ведут этот заказ
    "racersPerProfile": 3,                   // вкладок в профиле (≤ 6 рекомендовано)
    "targets": ["MK254AH/A", "MK244AH/A"],   // парты по приоритету
    "stores": ["R597", "R596", "R706"],      // магазины по приоритету
    "city": "Dubai",
    "slot": { "day": null, "after": null, "before": null },   // "16", "16:30", "18:00"
    "payment": "applepay",                   // или "manual" (карта)
    "applePayFallback": "manual",            // нет Apple Pay → карта; null — стоп
    "cardFallback": "applepay",              // поля карты не появились → Apple Pay; null — ждать человека
    "allowApplePayExpress": false,           // нет самовывоза → Apple Pay из корзины (доставка)
    "contact": { "firstName": "", "lastName": "", "email": "", "phone": "05XXXXXXXX" },
    "card": { "number": "", "expiry": "MM/YY", "cvv": "", "name": "" },
    "billing": { "title": "", "firstName": "", "lastName": "", "street": "", "area": "", "town": "", "city": "Dubai" },
    "autoReview": true,
    "autoPlaceOrder": false,
    "deliveryFallback": false,
    "address": { "street": "", "area": "", "city": "Dubai" }
  }],
  "timing": { /* §10 */ },
  "retries": { "checkout": 4, "slotsPerStore": 4 },
  "limits": { "maxTabsTotal": 12 }
}
```

Проверки при сохранении (ошибка — конфиг **не сохраняется**):
- имя, фамилия, email обязательны; телефон `^05\d{8}$`;
- парты и магазины только из известных списков;
- один профиль — один заказ;
- всего вкладок ≤ `maxTabsTotal`;
- номер карты 13–19 цифр и **проходит проверку Луна** (живой случай: опечатка в одной цифре → конфиг не сохранился → карта на Billing не ввелась);
- срок `MM/YY` или `MM/YYYY`, CVV 3–4 цифры;
- нижние пределы таймингов (рефреш не чаще 1,5 с, опрос не чаще 1 с, закрытый магазин не чаще 5 с, очередь ≥ 10 с, ожидание карты ≥ 3 с);
- боевая сборка работает только с `https://www.apple.com`.

Предупреждения: карта хранится открытым текстом (стереть после дропа); `autoPlaceOrder` может оформить заказ без человека; оплата картой без адреса плательщика; `openAt` в прошлом (нормально для тестов).

---

## 10. Тайминги по умолчанию

| Параметр | Значение | Смысл |
|---|---|---|
| `pollMs` | 1200 | опрос JSON наблюдателем (±30 %, не чаще 1000) |
| `closedReloadMs` | 30000 | рефреш закрытого магазина задолго до старта |
| `preOpenReloadMs` | 3000 | рефреш в последнюю минуту |
| `postOpenReloadMs` | 1500 | рефреш после старта |
| `minReloadMs` | 1500 | абсолютный минимум между рефрешами вкладки |
| `jitterPct` | 30 | разброс всех интервалов |
| `graceSec` | 20 | после `openAt` без сигнала OPEN — перейти на быстрый рефреш |
| `hydrateWaitMs` | 12000 | ожидание формы покупки на загруженной странице |
| `atbTimeoutMs` | 15000 | ответ на Add to Bag |
| `atb404BackoffMs` | 1500 | пауза после 404 |
| `atb404MaxInRow` | 5 | 404 подряд до стопа |
| `assistAfterFailures` | 3 | неудач шага до режима ассистента |
| `queueMaxWaitSec` | 90 | терпение на странице очереди |
| `checkoutErrorRetries` | 2 | повторы при общей ошибке чекаута |
| `cardWaitMs` | 10000 | ожидание полей карты |
| `holdLoserBagSec` | 90 | сколько запасной профиль держит товар |
| `manualPayTimeoutSec` | 600 | сколько ждать подтверждения оплаты |

Внутренние ожидания шагов: кнопка Add to Bag 8 с, trade-in 1,5 с, ответ `updateSummary` 5 с, активация Add to Bag 12 с, корзина 10 + 2 с, Check Out 8 с + смена URL 5 с, Guest 12 с + 6 с, страница Fulfillment 12 с, список магазинов 10 с, даты 5 с, окна 5 с, Continue 15 с, Billing 12 с, Review Your Order 4 с + 15 с, галочка 4 с, кнопка Apple Pay 5 с, Place Order 8 с.

---

## 11. Логи, приватность, данные заказов

**Лог** — кольцевой буфер 5000 строк в `chrome.storage.local`, формат:

```
[HH:MM:SS.mmm +сек_от_OPEN] [профиль · заказ · вкладка] СОСТОЯНИЕ: текст
[01:06:44.832 +35.770] [drop-1 · A · 2801585] PAYING: на оплату: Apple Dubai Mall · September 30 10:15 – 10:30
```

До OPEN вместо `+сек` пишется `T-47.9` (секунды до `openAt`). Перед записью каждая строка проходит фильтр: email → `ah***@e***.com`, телефон → `05******67`, любые 13–19 цифр подряд → `****1234`, `atbtoken` и прочие токены в URL обрезаются, длинные hex — до 4 символов. Значения адреса плательщика не пишутся, только список заполненных полей.

**Записи о заказах** (`chrome.storage.local` → `orders`, последние 200) — **без масок**, это данные владельца на его машине: профиль, заказ, статус, номер `W…`, товар и парт, магазин, окно, имя, фамилия, email, телефон, способ оплаты, сумма, времена OPEN / на оплате / оформлен. Экспорт в CSV (разделитель `;`, BOM для Excel/Numbers) из popup; с хабом — общая таблица всех профилей на дашборде и `GET /api/orders.csv`.

**Карта** хранится в `chrome.storage.local` открытым текстом и попадает в экспорт JSON. В логи не пишется. После дропа — стереть.

---

## 12. Устройство расширения

Chrome MV3, TypeScript, сборка esbuild.

```
src/
  manifest.json          права: storage, tabs, notifications, offscreen, webRequest (только наблюдение), alarms
  sw/                    service worker — оркестратор профиля
    orchestrator.ts      состояние заказа, лок Add to Bag, победитель, очередь оплаты, записи заказов, хаб, команды popup
    watcher.ts           роли вкладок (наблюдатель / гонщик)
    hubClient.ts         WebSocket к хабу с переподключением
    notify.ts, windows.ts, diag.ts (последние сетевые запросы вкладки для диагностики 404)
  content/               скрипт на страницах apple.com/ae — вся работа со страницей
    index.ts             классификация страницы → шаг машины состояний
    classify.ts          queue / closed / busy / notfound / product / attach / bag / signin / checkout(_s) / thankyou
    find.ts              устойчивый поиск элементов (§7)
    dom.ts               ожидания, React-ввод, клики
    router.ts            отслеживание смены URL в одностраничном чекауте
    assist.ts            режим ассистента (ждёт event.isTrusted)
    overlay.ts           плашка состояния и крупный баннер на странице
    steps/               preopen, addToBag, bag, guest, fulfillment, contact, payment, submit, closed, common, country, prepare
  shared/                config, selectors, parts, messages, log, watch (разбор fulfillment-messages)
  ui/                    popup (Start/Stop/Prepare/Clean bag/лог/заказы), options (настройки + JSON), offscreen (звук)
hub/server.mjs           хаб и дашборд
test/                    mock-server.mjs, e2e.mjs, unit.test.ts
```

Состояние вкладки живёт в `chrome.storage.session` под ключом `tab:<id>`: content script умирает при каждой перезагрузке страницы и восстанавливается из этого состояния. Состояние заказа профиля — там же под `order`.

**Состояния вкладки:** ARMED → PRE_RELOAD / WATCHING → FAST_RELOAD → ATB_PREP → ATB_WAIT_LOCK → ATB_PENDING → IN_BAG → CHECKOUT → GUEST → FULFILLMENT → CONTACT → BILLING → PAY_QUEUE → PAYING → REVIEW → ORDERED. Боковые: CLOSED, QUEUE, BUSY, COUNTRY, ASSIST, NEED_HUMAN, STANDBY, STOPPED, STUCK, PAY_TIMEOUT.

**Защита от торможения фоновых вкладок:** наблюдатель — активная вкладка своего окна; цепочки таймеров разрываются через MessageChannel; если наблюдатель не подаёт признаков жизни 3,5 с, опрос JSON берёт на себя service worker.

Сборки: `dist/` — боевая (только apple.com), `dist-dev/` — с поддержкой мока. Корень zip-набора для владельца — это и есть расширение (папка с `manifest.json`), dev-сборка лежит в `extension-dev/`.

---

## 13. Тестирование

### 13.1 Мок-сервер (`test/mock-server.mjs`, порт 4777)

Воспроизводит apple.com/ae от страницы товара до номера заказа, с переключателями сбоев через переменные окружения:

| Переменная | Что имитирует |
|---|---|
| `OPEN_AFTER` | через сколько секунд «открываются» продажи |
| `BUSY_FIRST` | первые заходы — заглушка «Almost there» |
| `ATB_404_RATE`, `ATB_404_FIRST` | 404 на Add to Bag |
| `ACPART_DELAY_MS` | задержка `updateSummary` |
| `COUNTRY_PICKER` | баннер выбора страны |
| `REQUIRE_TRUSTED` | Add to Bag только от настоящего клика |
| `UNAVAILABLE_STORES` | магазины без наличия |
| `TAKEN_FIRST_SLOT` | первое окно каждой даты «занято» |
| `HYDRATE_MS`, `ATTACH_DELAY_MS` | медленная гидратация, задержка `step=attach` |
| `DEFAULT_CITY` | город в чекауте по умолчанию |
| `STORE_CLOSED` | `blank` / `backsoon` / `redirect` / `offsite` — закрытый магазин |
| `QUEUE_AFTER_OPEN` | страница очереди с meta refresh |
| `CHECKOUT_ERR_FIRST` | «An unexpected error occurred. Please try again.» на Continue |
| `EMPTY_BAG_FIRST` | пустая корзина после Add to Bag |
| `RENAME_AUTOM` | все `data-autom` переименованы |
| `CARD_DELAY_MS` | блок карты появляется с задержкой |
| `THREEDS_MS` | после Place Order — «подтверди в приложении банка» |

Billing и Review мока повторяют живые экраны 30.09: адрес плательщика обязателен, галочка условий обязательна, кнопка «Continue with [логотип] Pay».

### 13.2 e2e (`node test/e2e.mjs`, настоящий Chromium через playwright-core с загруженным расширением)

| Сценарий | Что проверяет |
|---|---|
| single | полный путь до Billing ~6–7 с после OPEN; магазин без наличия → следующий; занятое окно → следующее; карта и адрес заполнены; Review открыт; Place Order — «человек»; номер пойман; запись и CSV; в логе нет токена, контактов, карты, адреса |
| hostile | 2 вкладки, выбор страны, 404 на Add to Bag, заглушка, смена города, Apple Pay; в корзине 1 шт. |
| assist | после серии 404 на Add to Bag вкладка переходит в режим ассистента, кнопку жмёт «человек», дальше путь идёт сам |
| prepare | прогрев профиля |
| queue | страница очереди не перезагружается |
| checkout-errors | общая ошибка → повтор того же окна/контакта; пустая корзина → повтор |
| renamed-selectors | все `data-autom` переименованы — путь проходит по запасным селекторам |
| applepay-turn | Review, галочка до клика, один клик «Continue with Pay», заказ не размещён |
| card-slow | блок карты через 4 с — дождались, фолбэк не сработал |
| card-fallback | блок карты не появился — переключение на Apple Pay |
| auto-place | карта + `autoPlaceOrder`: галочка, ровно один клик, один заказ, номер пойман |
| closed-backsoon / redirect / offsite / blank | магазин закрыт разными способами — вкладки ждут и проходят после открытия |
| acceptance | 3 заказа × 2 профиля × 2 вкладки + хаб: все на Billing ≤ 10 с после OPEN, без дублей |

Юнит-тесты (13): каталог партов и URL, сопоставление названия в корзине, нормализация и валидация конфига, выбор заказа профиля, джиттер, разбор и порядок окон, маскирование и формат лога, ключ шага одностраничного чекаута, фазы рефреша закрытого магазина, разбор `fulfillment-messages`.

### 13.3 Живые тесты на iPhone 18 Pro (`test-setup/README.md`)

| Тест | Что | Статус на 30.09 |
|---|---|---|
| T1 | одна вкладка до Billing | пройден (живой прогон дошёл до Billing и Review) |
| T2 | 3 вкладки: Add to Bag жмёт одна | — |
| T3 | 404 на Add to Bag → ассистент | — |
| T4 | HTML баннера выбора страны | не снят |
| T5 / T10 | Apple Pay: Review и лист с кодом | дошли до Review; нашли галочку условий (исправлено); открытие листа не подтверждено |
| T6 | 3 профиля + хаб | — |
| T7 | смена города Dubai → Abu Dhabi | — |
| T8 | есть ли окно в день дропа | — |
| T9 | точный текст «окно занято» | — |
| T11 | карта + Billing Address | нашли медленный блок карты и обязательный адрес (исправлено), повтор нужен |
| T12 | Place Order самим + 3-D Secure | не проводился |

---

## 14. Хронология

| Коммит | Что |
|---|---|
| 45633ab | первая версия расширения по ТЗ v3 |
| fb621c4, 5450120 | загрузка: корень набора — само расширение (у владельца дважды не грузилось из-за не той папки) |
| 37bea49 | тестовый набор: живые конфиги T1–T7, мок |
| 9b8cc62 | закрытый магазин перед дропом: пустая страница, «We'll be back», редиректы |
| 4299a7d | по итогам исследования 18 Pro: очередь Apple, повторы общих ошибок, торможение фоновых вкладок |
| 389736a | боевая сборка не принимает адрес мока; Start проверяет, что мок жив |
| 7a30a8e | автозаполнение карты, авто-Review, попытка Apple Pay, записи о заказах, запасные селекторы |
| 33f3cbb | живой тест: галочка Terms & Conditions на Review |
| 9c2537f | живой тест: Billing Address при карте |
| 959e9e0 | живой тест: ожидание блока карты до 10 с и фолбэк на Apple Pay |
| d9dc572 | Place Order при карте по флагу, один клик |
| (03.10) | **Бот (docs/BOT-SPEC.md), этапы 1–10:** оркестратор `bot/` (CLI check/prepare/start/status/stop/report/bench/wipe), лаунчер Chrome с `bootstrap.json`, хаб бота (назначение заказов после ADMITTED, пул карт и ворота Place Order по карте, очередь внимания, сторож, адаптация H1, дашборд), форвардер прокси (HTTP/SOCKS5 с логином), Telegram/вебхуки/файл заказов; режим бота в расширении (hold, исход Place Order, отказ карты → Apple Pay, замена карты, лестница кликов Apple Pay, классы `blocked`/`captcha`, кнопки человека, снимки, разбивка времени шагов); мок: `ADMIT_MODE`, `DECLINE_LAST4`, `PLACE_GENERIC_ERR`, `APPLEPAY_*`, `BLOCK_AFTER_SESSIONS`, `CAPTCHA_AT`, `HANG_STORES`; 16 e2e бота (включая прогрев), 13 юнит-тестов бота |
| (03.10) | Исправлено в расширении: проверка «ошибка про галочку условий» срабатывала на подпись самой галочки («…agree to the Terms…») — на живом сайте это давало лишний повторный клик по оплате. Поля форм заполняются одним проходом, фиксированные паузы (выбор магазина, контакт, ответ чекаута) заменены ожиданием события с прежним значением как верхней границей; опрос смены шага 150 → 50 мс |
| (03.10) | **Пульт бота** (`npm run bot -- ui`, на Mac — `Apple Drop Bot.command`): заказы, получатели, карты, прокси и настройки в форме с проверкой полей на лету; сохранение в `bot.config.json` / `secrets.local.json` (600); кнопки сборки расширения, установки Chrome, check, prepare, запуска (оркестратор detached + `caffeinate`), остановки, отчёта; только 127.0.0.1, токен, проверка Host. E2E `ui`, юнит-тест формы |
| (04.10) | Первый запуск на Mac: браузеры открылись и стояли в STARTING без объяснений. Теперь лаунчер не запускает фирменный Chrome ≥137 (молча игнорирует `--load-extension`), пульт показывает его как ✗ с кнопкой «Установить»; сторож запуска через `fleet.connectTimeoutSec` (25 с) объясняет причину по порту отладки и логу Chrome (`browser.no_connect`); в режиме бота расширение не открывает страницу настроек. E2E `no-connect` |
| (04.10) | Версия бота (коммит, `__BOT_VERSION__`) в шапке пульта и первой строке лога вместе с тем, какой Chrome запущен; пульт не запускает бота, если код в папке новее собранного (после `git pull` без перезапуска); `Apple Drop Bot.command` сам ставит Chrome for Testing; сторож подключения проверяет и подхваченные окна прошлого запуска |
| (04.10) | `install-chrome`: скачивание Chrome for Testing curl'ом по списку googlechromelabs (Stable, своя платформа) с докачкой и обрывом зависшей связи (<10 КБ/с 30 с), до 15 попыток, архив сохраняется между запусками; распаковка в `.part` и переименование; npx @puppeteer/browsers — запасной путь. `Apple Drop Bot.command` проверяет сам браузер, а не папку |
| (04.10) | Живые тесты на 18 Pro (Mac владельца): 404 «can’t be found» на адресе товара с хвостом `?product=…&step=…` принималась за заглушку BUSY и рефрешилась тем же адресом по кругу — теперь 404 распознаётся раньше заглушек, повтор после 404/заглушки в гонке идёт на чистый адрес цели (`offTarget`). STUCK переживал перезагрузку и вкладка вставала навсегда — сторож хаба лечит зависания до корзины сам (ATB_PREP 45 с, ATB_WAIT_LOCK 30 с, ATB_PENDING 20 с, STUCK 3 с → `reload_target` со сбросом счётчиков и STUCK, до 3 раз, потом человек); в бот-режиме STUCK до корзины не зовёт человека сразу. `bot diag` / «Собрать логи» в пульте — zip с замаскированными секретами. E2E `stale-404`, `atb-heal`, `diag` |

---

## 15. Открытые вопросы до 16.10

1. Открывает ли программный клик лист Apple Pay в Chrome или всегда нужен клик человека (T10).
2. Что именно происходит после Place Order с картой ОАЭ: окно 3-D Secure внутри страницы Apple, редирект на банк или только пуш в приложение; какой текст ошибки после отказа (T12).
3. Реальные `data-autom` полей Billing Address и кнопки Place Order (сейчас догадка + поиск по подписям).
4. Как выглядит страница очереди и заглушка именно на apple.com/ae.
5. Разметка баннера выбора страны (T4).
6. Принимает ли сайт программную смену города (T7).
7. Есть ли окна самовывоза на день дропа, на сколько дней вперёд даты (T8).
8. Точный текст ошибки «окно уже занято» (T9).
9. Хватает ли 10 с на блок карты под нагрузкой дропа или поднимать до 15 с.

---

## 16. Уроки для бота

1. **Сигнал открытия брать из JSON `fulfillment-messages`**, а не из рефреша страницы. Рефрешить много вкладок — лишняя нагрузка и риск блокировок.
2. **Никогда не уходить со страницы после клика Add to Bag**, пока сайт сам не перейдёт на `step=attach`. Иначе корзина пустая.
3. **Не строить URL Add to Bag и запросы чекаута руками** — `atbtoken`, `timeSlotId`, `signKey` выдаёт сервер. Только клики по интерфейсу.
4. **Ждать активации кнопок, а не снимать `disabled`.** Add to Bag активируется после ответа `updateSummary` на «No AppleCare».
5. **React:** нативный сеттер + события для полей, клик по label для radio, проверка результата после каждого действия.
6. **Различать три класса ошибок**: общая — повтор того же; про слот — следующее окно; валидация — к человеку.
7. **Не рефрешить страницу очереди.**
8. **Закрытый магазин — это не ошибка**, а ожидание с рефрешем по фазам.
9. **Одна корзина на профиль браузера**: несколько вкладок одного профиля должны договариваться, кто жмёт Add to Bag.
10. **Billing (карта):** ждать блок карты до 10 с, заполнять и карту, и Billing Address; иначе Review не откроется.
11. **Review:** сначала галочка условий, потом кнопка оплаты.
12. **Place Order — один клик за всю жизнь заказа.** После ошибки — проверить почту и номер, а не жать снова (дубли 12.09).
13. **Финальные подтверждения оплаты** (Apple Pay на телефоне, банк в приложении) — всегда человек.
14. **Не логировать** токены, cookie, карту, полные контакты; данные заказа хранить отдельно и локально.
15. **Проверять данные заранее**: номер карты по Луну, телефон `05XXXXXXXX`; ошибка в конфиге = сорванный шаг на дропе.
