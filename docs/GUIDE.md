# Apple Drop Assistant — настройка и доработка

Рабочая инструкция: как настроить расширение под дроп и как его менять. Что расширение умеет — в `docs/FEATURES.md`. Подробно как устроен сайт Apple по шагам и что подтверждено вживую — в `docs/HANDOFF.md`.

**Часть 1 — Настройка:** установка, профили, все поля, тайминги, готовые конфигурации, хаб, проверка, чтение лога.
**Часть 2 — Доработка:** окружение, где что лежит, как менять селекторы, поля настроек, шаги, мок, тесты, сборка архива, правила.

---

# Часть 1. Настройка

## 1.1 Установка и обновление

1. Собрать архив (§2.12) или взять готовый `apple-drop-test-setup.zip`, распаковать.
2. Chrome → `chrome://extensions` → включить «Режим разработчика» → «Загрузить распакованное» → выбрать **папку `apple-drop-test-setup`** (внутри лежит `manifest.json`; не выбирать папку выше или ниже).
3. Откроется страница настроек.

Две сборки:

| Папка | Для чего | Сайт |
|---|---|---|
| корень `apple-drop-test-setup` | боевая | только `https://www.apple.com` |
| `apple-drop-test-setup/extension-dev` | сухой прогон на моке | `http://127.0.0.1:4777` или apple.com |

Dev-сборку ставить только в отдельный профиль Chrome «Mock».

**Обновление на новую версию:** заменить файлы в той же папке → `chrome://extensions` → кнопка обновления у расширения. Настройки при этом сохраняются. Если расширение **удалить** и поставить заново — настройки пропадут, поэтому перед этим «Экспорт JSON».

## 1.2 Профили Chrome

- Один профиль Chrome = одна корзина Apple = один заказ одновременно. Нужно два заказа — нужно два профиля.
- Рекомендуемая схема на дроп: профили `Drop 1`, `Drop 2`, `Drop 3`, в каждом установлено расширение и задан свой `profileId` (`drop-1`, `drop-2`, `drop-3`).
- Открыть все профили разом на Mac: `./scripts/open-profiles.command 3` (имена папок профилей — `chrome://version` → «Путь к профилю»).
- Окружение: VPN выключен, язык Chrome English, часовой пояс Mac — Дубай, уведомления Chrome в macOS разрешены, звук не на нуле, Mac на зарядке, `caffeinate -d` в Терминале, окна профилей не сворачивать.

## 1.3 Все поля настроек

Страница настроек: слева форма, справа тот же конфиг в JSON. «Проверить и сохранить» — при ошибке **ничего не сохраняется**, сверху красный список. Импорт/экспорт JSON — кнопками сверху. `profileId` хранится отдельно и импортом не перетирается.

### Профиль

| Поле в форме | Ключ JSON | Что это | На 16.10 |
|---|---|---|---|
| profileId | `profileId` | имя профиля | `drop-1`, `drop-2`… свой в каждом |
| Хаб | `hubUrl` | адрес хаба | пусто для одного профиля; `ws://127.0.0.1:8765` для нескольких |
| openAt | `openAt` | старт продаж | `2026-10-16T16:00:00+04:00` |
| Режим | `mode` | `auto` / `assist` | `auto` |
| baseUrl | `baseUrl` | сайт | `https://www.apple.com` |

### Заказ (`orders[]`)

| Поле в форме | Ключ JSON | Что это | На 16.10 |
|---|---|---|---|
| id | `id` | имя заказа | `A`, `B`… |
| priority | `priority` | очередь оплаты, 1 — первый | по важности |
| profiles | `profiles` | профили, которые ведут заказ | один заказ — один или несколько профилей; один профиль — только один заказ |
| вкладок в профиле | `racersPerProfile` | сколько вкладок открыть | 2–3 (больше 6 — предупреждение) |
| targets | `targets` | парт-номера по приоритету | например `["MK254AH/A","MK244AH/A"]` — сначала Night Sky 256, потом Star White 256 |
| stores | `stores` | магазины по приоритету | `R597` Dubai Mall, `R596` MoE, `R706` Al Maryah, `R595` Yas, `R785` Al Jimi |
| Город | `city` | город в чекауте | город первого магазина; магазины другого города в этом списке не появятся |
| Слот: день | `slot.day` | число месяца | пусто — первая доступная дата |
| Слот: после / до | `slot.after`, `slot.before` | желаемое время `HH:MM` | пусто — любое; окна вне диапазона всё равно пробуются, но позже |
| Оплата | `payment` | `applepay` / `manual` (карта) | по решению владельца |
| Фолбэк Apple Pay | `applePayFallback` | нет Apple Pay → карта | `manual` |
| Фолбэк карты | `cardFallback` | поля карты не загрузились → Apple Pay | `applepay` |
| — | `allowApplePayExpress` | нет самовывоза → Apple Pay из корзины (доставка) | `false` |
| Имя, Фамилия | `contact.firstName/lastName` | получатель, как в документе | обязательно |
| Email | `contact.email` | почта для подтверждения | обязательно |
| Мобильный | `contact.phone` | `05XXXXXXXX` | обязательно |
| Карта: номер / срок / CVV / имя | `card.number/expiry/cvv/name` | автозаполнение карты | пусто — вводишь сам; номер проверяется по контрольной цифре |
| Плательщик: … | `billing.title/firstName/lastName/street/area/town/city` | Billing Address для карты | улица, Area, город обязательны; имя/фамилия пустые — берутся из получателя |
| Нажимать Review самим | `autoReview` | расширение жмёт «Review Your Order» | `true` |
| Нажимать Place Order самим | `autoPlaceOrder` | карта: один клик Place Order | по решению владельца; если банк не спросит подтверждение — заказ оформится сразу |
| Фолбэк доставки | `deliveryFallback` | нет самовывоза → доставка | `false`, если нужен только самовывоз |
| Адрес: улица / Area / город | `address.street/area/city` | адрес доставки; запасной источник для Billing Address | заполнить, если включён фолбэк доставки |

### Ограничения (`retries`, `limits`)

| Ключ | По умолчанию | Что это |
|---|---|---|
| `retries.checkout` | 4 | сколько раз начинать чекаут заново (Guest, 404 на чекауте) |
| `retries.slotsPerStore` | 4 | сколько окон пробовать в одном магазине |
| `limits.maxTabsTotal` | 12 | максимум вкладок на весь конфиг (больше 12 — предупреждение) |

## 1.4 Тайминги (`timing`, только в JSON)

| Ключ | По умолчанию | Нижний предел | Что это | Когда менять |
|---|---|---|---|---|
| `pollMs` | 1200 | 1000 | опрос «открылось ли» | не трогать |
| `closedReloadMs` | 30000 | 5000 | рефреш закрытого магазина задолго до старта | не трогать |
| `preOpenReloadMs` | 3000 | — | рефреш в последнюю минуту | не трогать |
| `postOpenReloadMs` | 1500 | `minReloadMs` | рефреш после старта | не трогать |
| `minReloadMs` | 1500 | 1500 | минимум между рефрешами вкладки | не трогать |
| `jitterPct` | 30 | — | разброс интервалов, % | не трогать |
| `graceSec` | 20 | — | через сколько после `openAt` без сигнала перейти на быстрый рефреш | — |
| `hydrateWaitMs` | 12000 | — | ожидание формы покупки под нагрузкой | увеличить, если в логе «нет формы покупки» при живом сайте |
| `atbTimeoutMs` | 15000 | — | ответ на Add to Bag | — |
| `atb404BackoffMs` | 1500 | — | пауза после 404 на Add to Bag | — |
| `atb404MaxInRow` | 5 | — | 404 подряд до стопа | — |
| `assistAfterFailures` | 3 | — | неудач подряд до режима ассистента | 1, если хочешь сразу жать сам |
| `queueMaxWaitSec` | 90 | 10 | терпение на странице очереди | увеличить, если очередь Apple дольше |
| `checkoutErrorRetries` | 2 | — | повторы при «unexpected error» | 3–4, если на дропе сыплются общие ошибки |
| `cardWaitMs` | 10000 | 3000 | ожидание блока карты | 15000, если в логе «появились через 8–10 с» |
| `holdLoserBagSec` | 90 | — | запасной профиль держит товар | — |
| `manualPayTimeoutSec` | 600 | — | ждать подтверждения оплаты | — |

Пределы проверяются при сохранении: чаще нельзя, чтобы не перегружать сайт Apple и не попасть под ограничения.

## 1.5 Готовые конфигурации

Шаблоны живых тестов лежат в `test-setup/live/` (`T1-T3-single.json`, `T2-three-tabs.json`, `T5-applepay.json`, `T6-hub-3-profiles.json`, `T7-city-abu-dhabi.json`), общий пример — `config.example.json`. Для дропа взять подходящий, поменять `targets` на Duo, `openAt` на 16.10 и вписать данные.

**Один профиль, Apple Pay** — фрагмент заказа:

```json
{
  "id": "A", "priority": 1, "profiles": ["drop-1"], "racersPerProfile": 3,
  "targets": ["MK254AH/A", "MK244AH/A"], "stores": ["R597", "R596", "R706", "R595"], "city": "Dubai",
  "payment": "applepay", "applePayFallback": "manual", "autoReview": true
}
```

**Один профиль, карта, Place Order жмёт расширение:**

```json
{
  "payment": "manual", "cardFallback": "applepay", "autoReview": true, "autoPlaceOrder": true,
  "card": { "number": "…", "expiry": "MM/YY", "cvv": "…", "name": "" },
  "billing": { "title": "", "firstName": "", "lastName": "", "street": "…", "area": "…", "town": "", "city": "Dubai" }
}
```

**Один заказ, три профиля и хаб** (кто первый положил — ведёт, остальные в запасе): во всех трёх профилях одинаковый JSON с `"hubUrl": "ws://127.0.0.1:8765"` и `"profiles": ["drop-1", "drop-2", "drop-3"]`, а `profileId` в каждом свой.

**Два заказа на два профиля:** два элемента в `orders` с разными `id` и `priority`, у каждого свой `profiles` (`["drop-1"]` и `["drop-2"]`), хаб обязателен для общей очереди оплаты.

## 1.6 Хаб

```
npm i          # один раз, в папке исходников
npm run hub    # держать Терминал открытым
```

- Порт и адрес меняются переменными `HUB_PORT` (8765) и `HUB_HOST` (127.0.0.1).
- Дашборд: `http://127.0.0.1:8765` — все вкладки всех профилей, победители, очередь оплаты, общая таблица заказов, кнопка «Следующий на оплату».
- `GET /api/state` — состояние JSON; `GET /api/orders.csv` — заказы всех профилей; `POST /api/next` — следующий на оплату; `POST /api/reset` — сбросить состояние хаба между тестами.
- Хаб упал или не запущен — профили работают каждый сам по себе, в popup красный значок «hub ○» (подключён — зелёный «hub ●»).

## 1.7 Проверка перед дропом

1. **Сухой прогон на моке** (5 минут): профиль «Mock» с `extension-dev` → импорт `mock/config-mock.json` → в Терминале `cd mock && ./run-mock.command` → Start. Ожидаемо: через 60 с «открытие», товар в корзине, самовывоз с пропуском занятого окна, контакты, остановка на оплате. Варианты: `STORE_CLOSED=blank ./run-mock.command`, `CARD_DELAY_MS=4000 ./run-mock.command`, список всех режимов — §2.9.
2. **Живые тесты** на iPhone 18 Pro по `test-setup/README.md` (T1–T12). После каждого — Clean bag.
3. **За день:** Prepare в каждом профиле; в popup строка «Prepare ✓» и что проверено.
4. **В день дропа:** открыть профили, проверить, что в popup нет красных ошибок, за 5–10 минут до 16:00 нажать Start в каждом. Хаб запустить до Start.
5. **После дропа:** экспорт заказов CSV, экспорт лога, стереть карту из настроек, Clean bag в запасных профилях.

## 1.8 Как читать лог

Формат: `[время +секунды_от_открытия] [профиль · заказ · вкладка] СОСТОЯНИЕ: текст`. До открытия вместо `+N` стоит `T-N` (секунды до `openAt`).

| Строка в логе | Что значит | Что делать |
|---|---|---|
| `селектор «addToBag» не найден — нашёл по: …` | Apple поменяла разметку, сработал запасной путь | работает; после дропа обновить селектор (§2.4) |
| `CLOSED: … рефреш через N с` | магазин закрыт | ничего, ждёт |
| `QUEUE: очередь Apple — страницу не трогаем` | страница очереди | ничего |
| `BUSY: заглушка Apple (N)` | нагрузка | ничего |
| `COUNTRY_PICKER (N)` | баннер страны | если 3 раза — проверить VPN и гео профиля |
| `ATB_RESULT ATB_404 · url … acpart=none:… atbtoken:…` | Apple отклонила Add to Bag; дальше диагностика | несколько раз — нормально; серия — ассистент; прислать строку разработчику |
| `корзина пуста после Add to Bag (N)` | сломанная сессия корзины | после 3 — Clean bag и Start или другой профиль |
| `Continue: ошибка общего вида «…» — повтор того же окна` | «unexpected error» | ничего, повторяет |
| `окно … не принято: …` | окно заняли | ничего, берёт следующее |
| `setSelect окна не принят приложением — ассистент` | сайт не принял выбор окна | выбрать окно руками в подсвеченном списке |
| `город «X» не найден в списке` | неверный город в настройках | поправить `city` |
| `NEED_HUMAN: контакты: Please …` | ошибка в поле | поправить поле в окне, нажать Continue |
| `поля карты появились через N с` | блок карты медленный | если N близко к 10 — поднять `cardWaitMs` |
| `поля карты не появились за N с — переключаюсь на Apple Pay` | сработал фолбэк карты | подтвердить Apple Pay с телефона |
| `карта в конфиге не задана` | карта пустая (или настройки не сохранились) | ввести карту руками; проверить, что настройки сохранены |
| `карта ****1234: заполнено …; не удалось: …` | часть полей не принялась | дописать руками; прислать разработчику |
| `адрес плательщика: … не удалось: …` | поле адреса не найдено | дописать руками; прислать outerHTML блока |
| `Billing Address нужен для карты, но … пусты` | нет адреса в настройках | заполнить «Плательщик» |
| `Review не открылся: Please complete this mandatory field` | на Billing пустое обязательное поле | заполнить руками, нажать Review |
| `условия продажи (Terms & Conditions) приняты` | галочка стоит | — |
| `чекбокс Terms & Conditions не найден` | галочку не нашли | поставить руками; прислать outerHTML |
| `программный клик Apple Pay лист не открыл (нужен клик человека)` | Chrome требует настоящий клик | нажать подсвеченную кнопку |
| `Place Order нажат (autoPlaceOrder)` | заказ отправлен | подтвердить в приложении банка |
| `после Place Order: … — повторно не нажимаю` | ошибка после Place Order | сначала почта и номер заказа, потом решать |
| `[sw] …` | опрос открытия ведёт фоновая часть расширения | вкладка-наблюдатель заторможена, но всё работает |
| `хаб не ответил на WIN_REQ за 3 с — продолжаю сам` | хаб недоступен | проверить Терминал с хабом |
| `STUCK: …` | вкладка встала, нужен человек | читать текст, действовать по нему |

---

# Часть 2. Доработка

## 2.1 Окружение и команды

Нужен Node.js 20+. В папке исходников один раз `npm i`.

| Команда | Что делает |
|---|---|
| `npm run build` | боевая сборка в `dist/` |
| `npm run build:dev` | dev-сборка в `dist-dev/` (мок + apple.com) |
| `npm run watch` | dev-сборка с пересборкой при изменениях |
| `npm run typecheck` | проверка типов TypeScript |
| `npm test` | юнит-тесты (13) |
| `npm run test:e2e` | dev-сборка + все e2e-сценарии на моке (~5 минут) |
| `node test/e2e.mjs single card-slow` | только выбранные сценарии |
| `npm run mock` | мок-сервер на `http://127.0.0.1:4777` |
| `npm run hub` | хаб на `ws://127.0.0.1:8765` |
| `npm run pack` | собрать `out/apple-drop-test-setup.zip` для установки |

Перед каждым коммитом: `npm run typecheck && npm test && npm run test:e2e`.

## 2.2 Где что лежит

```
src/manifest.json            базовый манифест (финальный пишет build.mjs)
src/shared/
  config.ts                  схема конфига, дефолты, нормализация, валидация, фазы рефреша
  selectors.ts               ВСЕ селекторы и тексты сайта Apple
  parts.ts                   парт-номера, URL товаров, магазины
  messages.ts                состояния вкладки/заказа и все сообщения между частями
  log.ts                     формат строки лога и маскирование
  watch.ts                   опрос и разбор fulfillment-messages
src/content/                 работает на страницах apple.com/ae
  index.ts                   вход: классификация страницы → нужный шаг; обработка сообщений SW
  classify.ts                что за страница (queue/closed/busy/notfound/product/attach/bag/signin/checkout/thankyou)
  find.ts                    устойчивый поиск элементов по ключам
  dom.ts                     ожидания, ввод, клики
  ctl.ts                     контроллер вкладки (API для шагов, §2.7)
  router.ts                  смена шага в одностраничном чекауте
  assist.ts, overlay.ts      ассистент, плашка/баннер на странице
  slots.ts                   порядок окон самовывоза
  steps/                     preopen, addToBag, bag, guest, fulfillment, contact, payment, submit, closed, common, country, prepare
src/sw/                      service worker
  orchestrator.ts            состояние заказа, лок Add to Bag, победитель, очередь оплаты, записи заказов, хаб, команды popup
  watcher.ts                 роли вкладок
  hubClient.ts, notify.ts, windows.ts, diag.ts
src/ui/                      popup, options, offscreen (звук), ui.css
hub/server.mjs               хаб + дашборд
test/mock-server.mjs         мок apple.com/ae
test/e2e.mjs                 e2e-сценарии
test/unit.test.ts            юнит-тесты
test-setup/                  README для тестов, live-конфиги, мок-конфиг, КАК-УСТАНОВИТЬ.txt
scripts/                     open-profiles.command (macOS), pack.sh
docs/                        SPEC (ТЗ v3), HANDOFF, FEATURES, GUIDE, RESEARCH
```

### Хочу поменять → куда идти

| Задача | Файл |
|---|---|
| селектор или текст кнопки Apple | `src/shared/selectors.ts` + спецификация в `src/content/find.ts` |
| распознавание закрытого магазина, очереди, заглушки, ошибок | регулярки `txt*` в `src/shared/selectors.ts`, правила в `src/content/classify.ts` |
| поведение на странице товара / Add to Bag | `steps/preopen.ts`, `steps/addToBag.ts` |
| корзина, Check Out | `steps/bag.ts` |
| самовывоз, магазины, окна | `steps/fulfillment.ts`, `slots.ts` |
| контакты | `steps/contact.ts` |
| оплата, карта, адрес, Review, Apple Pay, Place Order | `steps/payment.ts` |
| повторы при ошибках Continue | `steps/submit.ts` |
| частота рефрешей | `config.ts` (`DEFAULT_TIMING`, `phaseOf`, `closedReloadMs`), `steps/common.ts` (`busyMs`) |
| новое поле настроек | §2.5 |
| уведомления, звуки | `sw/notify.ts`, `ui/offscreen.ts` |
| плашка на странице | `content/overlay.ts` |
| кнопки popup | `ui/popup.html`, `ui/popup.ts`, команда в `orchestrator.ts` → `onCommand` |
| координация профилей | `hub/server.mjs`, `sw/orchestrator.ts` → `onHub` |
| парт-номера, магазины | `src/shared/parts.ts` |

## 2.3 Как устроено внутри (минимум для правок)

- **Content script** живёт на каждой странице apple.com/ae и умирает при каждой перезагрузке. Его память — `chrome.storage.session` под ключом `tab:<id>` (`TabState` в `messages.ts`). Всё, что должно пережить перезагрузку (флаги «уже нажал», счётчики), класть в `c.ts` и вызывать `await c.save()` **до** действия, которое перезагрузит страницу.
- **Цикл:** загрузка или смена шага → `dispatch()` в `index.ts` → `classify()` → шаг по `mode` вкладки (`race` / `checkout` / `standby` / `prep` / `clean`) и типу страницы → функция из `steps/`.
- **`c.rerun(reason)`** отменяет текущий шаг (все ожидания по `c.signal` бросают `Aborted`, таймеры `c.timer` сбрасываются) и запускает `dispatch()` заново. Так реагируют на смену URL, сообщения SW, паузу.
- **Service worker** — один на профиль: выдаёт лок Add to Bag, выбирает победителя, держит очередь оплаты, пишет лог и записи заказов, общается с хабом. Может выгружаться Chrome-ом; состояние заказа тоже в `chrome.storage.session` (`order`).
- **Сообщения:** content → SW (`C2S`), SW → content (`S2C`), SW ↔ хаб (`S2Hub` / `Hub2S`), все типы в `messages.ts`.

## 2.4 Как обновить селекторы после живого теста

Самая частая доработка.

1. В логе найти строки `селектор «<ключ>» не найден — нашёл по: <как>`. Ключ — имя в `F` из `src/content/find.ts` (`addToBag`, `guest`, `billStreet`, `termsCheckbox`…).
2. Получить реальную разметку: правый клик по элементу → «Просмотреть код» → на элементе Copy → Copy outerHTML.
3. Обновить основной селектор:
   - если ключ ссылается на `SEL.*` — поменять значение в `src/shared/selectors.ts`;
   - если селектор записан прямо в `F` (поля Billing Address, `termsCheckbox`, `placeOrderButton`, `applePayButton`, поля карты) — поменять `sel` в `src/content/find.ts`.
4. Старый селектор не удалять, а перенести в `alt` — вдруг вернётся.
5. Если поменялся текст на кнопке — поправить `text` (регулярка) в `F`.
6. Тексты страниц (закрыт, очередь, ошибки) — регулярки `txt*` в `selectors.ts`. Добавлять варианты через `|`, старые не удалять.
7. Повторить разметку в моке (`test/mock-server.mjs`), если хочешь, чтобы тест ловил регресс.
8. `npm run typecheck && node test/e2e.mjs single renamed-selectors`.

Как устроен поиск (`findAll` в `find.ts`): основной `sel` → по очереди `alt` → для кнопок текст видимой кнопки / `value` / `aria-label` → для radio текст `<label>` → для чекбоксов подпись или соседний текст → для полей и select атрибуты `name`, `autocomplete`, `placeholder`, `aria-label`, `id`, текст `<label>`. Ключ описывается так:

```ts
billStreet: {
  sel: SEL.shipStreet,                                   // основной
  alt: ['input[autocomplete="address-line1"]', 'input[name*="street" i]:not([name*="2"])'],
  attr: /^street|street address|address line 1/i,        // для полей и select
  kind: 'field',                                         // button | radio | field | select | checkbox | any
},
```

Использование в шагах: `findEl(key)`, `findAll(key)`, `findField(key, root?)`, `findSelect(key, root?)`, `findRadio(key, value, labelRe?, root?)`, `waitEl(key, ms, c.signal)`, `waitEnabled(key, ms, c.signal)`. Сырые `document.querySelector` для элементов Apple в шагах не использовать — теряется запасной поиск и отчёт в лог.

## 2.5 Как добавить поле в настройки

Пример — уже сделанные `billing`, `cardFallback`, `autoPlaceOrder`. Места, которые нужно тронуть:

1. `src/shared/config.ts`:
   - тип в `OrderCfg` (или `Timing` / `Config`) с комментарием;
   - значение по умолчанию в `defaultOrder()` (для тайминга — в `DEFAULT_TIMING`; тайминги нормализуются автоматически);
   - разбор в `normalizeConfig()` (старые JSON без поля должны получить дефолт);
   - проверка или предупреждение в `validateConfig()`, если нужно.
2. `src/ui/options.html` — `<label>` + поле + подсказка `.hint`.
3. `src/ui/options.ts` — заполнение формы из конфига (`orderToForm`) и обратно (`formToOrder`).
4. Использование в шаге через `c.order.<поле>` или `c.t.<тайминг>`.
5. Живые конфиги `test-setup/live/*.json`, `test-setup/mock/config-mock.json`, `config.example.json` — добавить поле со значением по умолчанию.
6. `test/e2e.mjs` → `makeOrder()` — дефолт для тестов; при необходимости новый сценарий.
7. `test/unit.test.ts` — если есть валидация.
8. Описание в `docs/FEATURES.md` и в этом файле (§1.3 / §1.4).

## 2.6 Как добавить или изменить шаг

1. Если это новый тип страницы — правило в `classify()` (`src/content/classify.ts`) и новый `kind`.
2. Ветка в `dispatch()` / `raceStep()` / `checkoutStep()` в `src/content/index.ts`. Шаги чекаута выбираются по `_s=` (`page.step`, без `-init`, в нижнем регистре).
3. Функция шага в `src/content/steps/<имя>.ts`, принимает `c: Ctl`.

Правила для кода шага:
- все ожидания с `c.signal` (`waitUntil(..., ms, c.signal)`, `sleep(ms, c.signal)`) — иначе шаг не отменится при смене страницы;
- состояние показывать через `c.setState('СОСТОЯНИЕ', 'деталь')` (уходит в лог, popup, хаб, плашку);
- элементы искать через `find.ts`;
- ввод — `setInput`, `setSelect`, `pickRadio`, клик — `clickEl` (React не видит прямое присваивание `value`);
- кнопку «Continue» нажимать через `submitAndWait(c, btn, /_s=Следующий/i, регулярка_ошибок)` — он сам различает успех, ошибку и таймаут и классифицирует ошибку (`generic`);
- переходы — `c.navigate(url, 'почему', rateLimited)` и `c.reload('почему')` (соблюдают минимум 1,5 с между рефрешами);
- нужен человек — `assistClick(c, кнопка, 'Шаг', 'Текст')` / `assistSelect(...)`, `c.alert(заголовок, текст)`, `c.overlay.banner(заголовок, подзаголовок, 'warn')`;
- нельзя повторять действие после перезагрузки — флаг в `c.ts` + `await c.save()` до действия (пример — `placeOrderTried` в `payment.ts`);
- в лог не писать значения полей (только «заполнено: имя, улица…»), номер карты — только `****1234`.

## 2.7 API контроллера вкладки (`Ctl`, `src/content/ctl.ts`)

| Член | Что делает |
|---|---|
| `c.cfg`, `c.order`, `c.t` | конфиг, заказ профиля, тайминги |
| `c.ts` | состояние вкладки (переживает перезагрузку после `c.save()`) |
| `c.os` | состояние заказа профиля (только чтение, владелец — SW) |
| `c.role` | `watcher` / `racer` / `standby` / `idle` |
| `c.signal` | отмена текущего шага |
| `c.target()`, `c.targetUrl()`, `c.bagUrl()`, `c.base` | цель и адреса |
| `c.setState(state, detail?, patch?)` | состояние + лог + popup + хаб + плашка |
| `c.setMode(mode, patch?)` | `race` / `checkout` / `standby` / `prep` / `clean` / `idle` |
| `c.log(msg, level?)` | строка в лог |
| `c.save()` | сохранить `c.ts` |
| `c.timer(ms, fn)` | таймер шага (сбрасывается при `rerun`) |
| `c.rerun(reason)` | перезапустить обработку страницы |
| `c.stopAll()` | отменить всё текущее |
| `c.navigate(url, why, rateLimited?)`, `c.reload(why)`, `c.scheduleReload(ms, why)` | переходы |
| `c.send(msg)`, `c.request(msg, replyType, ms)` | сообщения в SW |
| `c.acquireLock(ttl)` | лок Add to Bag |
| `c.assistFor(step)`, `c.fail(step)` | счётчик неудач и включение ассистента |
| `c.alert(title, msg)` | уведомление со звуком |
| `c.overlay.banner(...)`, `c.renderOverlay(...)` | баннер и плашка на странице |
| `c.jit(ms)` | интервал с джиттером |

Помощники `src/content/dom.ts`: `sleep`, `yieldTask`, `waitUntil`, `waitFor`, `waitForText`, `waitForUrl`, `waitForUrlChange`, `raceFirst`, `waitForResource` (сетевой запрос через PerformanceObserver), `resolveInput`, `isChecked`, `pickRadio`, `setSelect`, `setInput`, `isEnabled`, `clickable`, `clickEl`, `textOf`, `bodyText`, `isVisible`, `errorContext`, `cookieNames`.

## 2.8 Новое сообщение между частями

1. Тип в union `C2S` / `S2C` / `S2Hub` / `Hub2S` в `src/shared/messages.ts`.
2. Отправка: из шага `c.send({...})`; из SW `this.sendTab(tabId, {...})` или `this.hub.send({...})`.
3. Обработка: SW — `onTabMsg` / `onHub` в `orchestrator.ts`; content — `onSwMessage` в `index.ts`; хаб — `onMsg` в `hub/server.mjs`.
4. TypeScript подскажет все `switch`, где нужен новый `case`.

## 2.9 Мок-сервер

`test/mock-server.mjs` — копия нужных страниц apple.com/ae (товар, attach, корзина, signIn, чекаут Fulfillment → PickupContact → Billing → Review, thank-you) и JSON `fulfillment-messages`. Разметка повторяет живой сайт (`data-autom`, скрытые radio, React-подобная валидация).

Режимы через переменные окружения (список в шапке файла):

`OPEN_AFTER`, `BUSY_FIRST`, `ATB_404_RATE`, `ATB_404_FIRST`, `ACPART_DELAY_MS`, `COUNTRY_PICKER`, `REQUIRE_TRUSTED`, `UNAVAILABLE_STORES`, `TAKEN_FIRST_SLOT`, `HYDRATE_MS`, `ATTACH_DELAY_MS`, `DEFAULT_CITY`, `STORE_CLOSED` (`blank` / `backsoon` / `redirect` / `offsite`), `QUEUE_AFTER_OPEN`, `CHECKOUT_ERR_FIRST`, `EMPTY_BAG_FIRST`, `RENAME_AUTOM`, `CARD_DELAY_MS`, `THREEDS_MS`.

Служебные адреса: `GET /__state` (сессии, корзины, что было отправлено на каждом шаге, заказы), `POST /__reset`, `POST /__config` (поменять режимы на лету).

Новый режим: строка-описание в шапке → поле в объекте `S` (из `env`) → если нужно на клиенте, передать в `boot` страницы → логика в HTML/JS страницы или в обработчике `/ae/shop/checkoutx` → записать факт в `s.checkout`, чтобы e2e мог проверить через `/__state`.

## 2.10 e2e-тесты

- Запуск: `node test/e2e.mjs` (все) или с именами сценариев. `HEADED=1` — видимый браузер. `CHROME_PATH=/путь/к/chrome` — свой Chrome/Chromium.
- Каждый сценарий поднимает мок (и хаб, если нужно), запускает чистые профили Chromium с `dist-dev`, задаёт конфиг, жмёт Start через popup и проверяет результат через `status` расширения и `/__state` мока.
- При падении в `test/.artifacts/` складываются статус расширения, лог, скриншоты вкладок и логи мока/хаба.

Шаблон нового сценария:

```js
scenarios['my-case'] = async () => {
  await startServers({ OPEN_AFTER: '0', BUSY_FIRST: '0', CARD_DELAY_MS: '4000' });
  const p = await launchProfile('mycase');
  const profiles = [p];
  try {
    await p.setConfig(makeConfig('drop-1', [makeOrder('A', 0, ['drop-1'], { racersPerProfile: 1, card: CARD })], { openInSec: -5 }));
    const r = await p.cmd({ cmd: 'start' });
    assert.ok(r.ok, r.error);
    await waitFor(async () => (await p.status()).os.billingReadyAt, 60000, 'Billing', 500);
    const ms = await mockState();
    const log = (await p.cmd({ cmd: 'exportLog' })).text;
    // assert.equal(...), assert.ok(/строка лога/.test(log), ...)
  } catch (e) { await dumpOnFail(profiles, 'my-case'); throw e; } finally { await closeProfiles(profiles); await stopServers(); }
};
```

и добавить имя в список `list` внизу файла.

Текущие сценарии: `single`, `hostile`, `assist`, `prepare`, `queue`, `checkout-errors`, `renamed-selectors`, `applepay-turn`, `card-slow`, `card-fallback`, `auto-place`, `closed-backsoon`, `closed-redirect`, `closed-offsite`, `closed-blank`, `acceptance`.

Юнит-тесты (`test/unit.test.ts`, `npm test`) — для чистых функций: конфиг, валидация, слоты, маскирование, разбор JSON, роутер, фазы.

## 2.11 Сборка

`build.mjs` (esbuild):
- `dist/` — боевая: `__DEV__ = false`, по умолчанию `https://www.apple.com`, мок запрещён валидацией;
- `dist-dev/` — `__DEV__ = true`, по умолчанию мок, с source maps;
- `dist-test/` — юнит-тесты.

## 2.12 Архив для установки

```
npm run pack
```

Результат — `out/apple-drop-test-setup.zip`. Внутри папка `apple-drop-test-setup`: в корне боевая сборка (её и выбирать в Chrome), `extension-dev/`, `live/`, `mock/` (конфиг, `run-mock.command`, `mock-server.mjs`), README тестов, `КАК-УСТАНОВИТЬ.txt`, FEATURES, GUIDE, RESEARCH.

## 2.13 Git

- Рабочая ветка: `claude/modest-goldberg-8ufyyx` (репозиторий `georgii-korzion/applebot`).
- Один коммит — одна логическая правка, в сообщении: что и почему (особенно если правка по итогам живого теста — что увидели на сайте).
- Перед коммитом: typecheck, юнит, e2e.

## 2.14 Правила, которые нельзя нарушать

- Не обходить защиту Apple: никаких подмен отпечатков/User-Agent, прокси-ротации, решения капч, подделки `atbtoken`, `x-aos-stk`, Apple Shield, никакого `chrome.debugger`.
- Не строить URL Add to Bag и запросы чекаута руками: `atbtoken`, `timeSlotId`, `signKey` выдаёт сервер — только клики по интерфейсу.
- Не уходить со страницы между кликом Add to Bag и `step=attach`.
- Не снимать `disabled` с кнопок — ждать, пока сайт активирует.
- Рефреш не чаще 1,5 с, опрос не чаще 1 с (проверяется валидацией — пределы не ослаблять).
- Подтверждение Apple Pay и подтверждение банка — только человек. Place Order — не больше одного клика за жизнь заказа.
- В лог — никаких токенов, cookie, номеров карт, полных контактов, адресов (`scrub()` в `log.ts` — страховка, не повод писать лишнее).
- Не генерировать личности покупателей.

## 2.15 Бэклог: что проверить и доработать до 16.10

| Что | Как узнать | Где править |
|---|---|---|
| Открывает ли клик расширения лист Apple Pay | тест T10, строка лога про «нужен клик человека» | `steps/payment.ts` → `tryApplePay` |
| Что после Place Order с картой (3-D Secure внутри страницы, редирект банка, только пуш) и текст ошибки после отказа | тест T12 | `steps/payment.ts` → `tryPlaceOrder`; распознавание страницы банка — `classify.ts` |
| Реальные `data-autom` полей Billing Address и кнопки Place Order | outerHTML со страниц | `find.ts` → `bill*`, `placeOrderButton` |
| Вид страницы очереди и заглушки на apple.com/ae | скриншот/HTML в день дропа или на ближайшем релизе | `selectors.ts` → `txtQueue`, `txtClosed`, `txtBusy` |
| Разметка баннера выбора страны | тест T4 | `selectors.ts` → `countryContainers`, `txtCountry`; `steps/country.ts` |
| Принимается ли программная смена города | тест T7 | `steps/fulfillment.ts` → `ensureCity` |
| Есть ли окна в день дропа | тест T8 | конфиг `slot.day` |
| Точный текст ошибки «окно занято» | тест T9 | `selectors.ts` → `txtSlotError` |
| Хватает ли 10 с на блок карты | строка «поля карты появились через N с» | `timing.cardWaitMs` |
