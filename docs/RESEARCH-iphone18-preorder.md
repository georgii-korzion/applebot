# Как прошёл предзаказ iPhone 18 Pro (12.09.2026) и что из этого учтено в расширении

Собрано 29.09.2026 по публикациям и форумам (прямой доступ к части страниц был закрыт, использованы выдачи поиска). Всё, что ниже, — про apple.com в целом; текст заглушек на apple.com/ae не снят.

## Факты

| Что | Источник |
|---|---|
| Магазин закрыли за несколько часов до старта. Текст на apple.com (US): **«We love that early energy. Almost ready for you. Pre-order begins at 5:00 a.m. PT. See you soon»**. Кнопки Buy на страницах устройств вели на закрытый магазин. | MacRumors «Apple Store Down Ahead of iPhone 18 Pro Pre-Orders», AppleInsider, The Apple Post |
| Магазин и приложение **оставались недоступными несколько минут после объявленного времени** старта. | The Apple Post «iPhone 18 Pro pre-orders hit by errors» |
| По наблюдению AppleInsider, в этом году у Apple **очередь вместо рефреш-долбёжки**: страница заказа открывается, когда подошла твоя очередь. Официально Apple ничего про очередь не публиковала (MacObserver). | AppleInsider «preorders are live», MacObserver «Apple's Published Sequence Is One Sentence Long» |
| На чекауте многие получали **ошибки общего вида** («unexpected error»), оплата падала и картой, и Apple Pay; **помогал повтор**. | The Apple Post, MacRumors Forums |
| **Дубли заказов**: заказ проходил без письма и без записи в истории, люди оформляли второй. | The Apple Post |
| **«Page not found» на последнем шаге** и «корзина пуста после Add to Bag» — сломанная сессия; лечение: очистить корзину и начать заново. | Apple Community, MacObserver «Apple PreOrders not Working» |
| «Get Ready» — сохранить конфигурацию и оплату заранее (держится 3 дня). **Нужен вход в Apple Account**, для гостевого чекаута не работает. | 9to5Mac, AppleInsider, MacRumors |
| Приложение Apple Store, по мнению прессы, быстрее сайта (сохранённые данные). Apple разницы не заявляла. | MacObserver, MacRumors |
| ОАЭ: старт в 16:00, **квоты предзаказа разошлись меньше чем за 20 минут**; самовывоз в Dubai Mall, Mall of the Emirates, Yas Mall, Al Maryah. Запас самовывоза отделён от запаса доставки — слот в магазине мог быть доступен, когда доставка уже уехала на недели. | tbreak, Khaleej Times, Gulf News |
| Каждое изменение корзины заново запрашивает наличие — меньше правок в корзине, быстрее до оплаты. | Gulf News (гайд по ОАЭ) |

## Что сделано в расширении

- **Закрытый магазин.** Тексты «early energy / Almost ready for you / Pre-order begins at / See you soon» добавлены к распознаванию; пустая страница, 404 и редиректы распознаются без текста. Вкладки обновляются по фазам (30 с → 3 с → 1,5 с), с 16:00 — сразу, без ожидания сигнала. Магазин, недоступный ещё несколько минут после старта, отрабатывается тем же путём.
- **Очередь.** Страница с текстом очереди («in line», «your turn», «don't refresh»…) или с `<meta http-equiv="refresh">` **не перезагружается расширением**: ждём, пока она сама пустит дальше (лимит `queueMaxWaitSec`, 90 с), после этого — один рефреш. Заглушка с meta refresh после старта тоже отдаётся браузеру, наш таймер — только страховка. Очередь после клика Add to Bag не считается провалом: ждём, пока вернёт на добавление.
- **Ошибки чекаута.** Continue на Fulfillment / Contact / Shipping: ошибка общего вида («unexpected error», «something went wrong», «try again») → повтор того же действия до `checkoutErrorRetries` (2) раз, не отдавая выбранное окно; ошибка про слот → следующее окно; ошибка валидации («Please enter…») → стоп, нужен человек. Конец запроса ловится по XHR `checkoutx` и по циклу disabled→enabled кнопки, поэтому одинаковый текст ошибки два раза подряд не вызывает 15-секундного ожидания.
- **Дубли заказов.** На плашке оплаты и на экране Review — предупреждение: ошибка после Place Order → сначала проверить почту и номер заказа, потом повторять.
- **Пустая корзина после Add to Bag.** До 3 повторов, затем `STUCK` с уведомлением (сессия корзины сломана — нужен человек или другой профиль).
- **Скорость.** Гидратация страницы товара под нагрузкой ждётся до `hydrateWaitMs` (12 с), если разметка товара уже пришла; проверка trade-in не тратит 8 с, если секции нет; после OPEN свежезагруженная страница не перезагружается второй раз.

## Что расширение сделать не может

- «Get Ready» и приложение Apple Store — только с Apple Account. Гостевой чекаут расширения этого не использует. Если есть аккаунты, отдельный профиль с «Get Ready» — параллельный ручной путь, он никак не конфликтует с расширением.
- Точный вид страницы очереди и заглушки на apple.com/ae неизвестен. Распознавание идёт по общим признакам (нет разметки товара, meta refresh, характерные слова); если 16.10 увидишь заглушку — скриншот/HTML в лог поможет уточнить `selectors.ts`.

## Источники

- https://www.macrumors.com/2026/09/12/apple-store-down-iphone-18-pro-pre-orders/
- https://forums.macrumors.com/threads/apple-store-down-ahead-of-iphone-18-pro-pre-orders.2489108/
- https://appleinsider.com/articles/26/09/12/preorders-for-the-iphone-18-pro-and-iphone-18-pro-max-are-now-live
- https://appleinsider.com/articles/26/09/12/apple-store-goes-down-as-iphone-18-pro-preorders-loom
- https://www.theapplepost.com/2026/09/12/72222/iphone-18-pro-pre-orders-hit-by-errors-as-customers-struggle-to-place-orders/
- https://www.macobserver.com/news/iphone-18-pro-pre-order-morning-what-apples-buy-page-shows/
- https://www.macobserver.com/tips/round-ups/apple-store-app-or-website-iphone-18-pro-preorder/
- https://www.macobserver.com/news/apple-preorders-not-working-potential-fixes/
- https://9to5mac.com/2026/09/11/apple-sets-cutoff-time-for-getting-faster-iphone-18-pro-pre-order/
- https://www.macrumors.com/how-to/pre-order-your-iphone-18-pro-from-apple/
- https://discussions.apple.com/thread/256133744
- https://tbreak.com/apple-store-down-uae-iphone-18-pro-pre-orders/
- https://tbreak.com/iphone-18-pro-pre-order-uae-guide/
- https://www.khaleejtimes.com/business/tech/how-to-pre-order-iphone-18-pro-pro-max-uae-walk-in
- https://www.khaleejtimes.com/business/tech/iphone-18-uae-pro-pro-max-sell-out-on-strong-pre-order-demand-retailers-say
- https://gulfnews.com/business/retail/iphone-18-pro-starts-at-dh5099-in-uae-with-pre-orders-opening-september-12-1.500668984
