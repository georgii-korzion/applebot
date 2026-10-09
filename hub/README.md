# Хаб v2 — деплой

Один процесс Node 20, единственная зависимость `ws`. Хаб **только наблюдает**: раздаёт профилям конфиг из
`fleet.json`, собирает их состояние и записи заказов, показывает дашборд и рассылает команды. Ни один шаг покупки
ответа хаба не ждёт — хаб можно выключить посреди дропа, профили продолжат сами (e2e `hub-down`).

## Переменные окружения

| Переменная | По умолчанию | Что |
|---|---|---|
| `HUB_TOKEN` | пусто (без авторизации!) | токен расширений: `wss://host/ws?token=<HUB_TOKEN>`, он же для `GET /config/<id>` |
| `HUB_DASH_TOKEN` | пусто (без авторизации!) | токен дашборда и API: `https://host/?token=<HUB_DASH_TOKEN>` или заголовок `X-Token` |
| `HUB_PORT` | `PORT`, иначе `8765` | порт; `PORT` задаёт Railway сам |
| `HUB_HOST` | `0.0.0.0` | адрес |
| `FLEET_FILE` | `./fleet.json` | путь к fleet.json (образец — `fleet.example.json` в корне репозитория) |
| `RUNTIME_DIR` | `./runtime` | состояние: `state.json`, `records.json`, `log.ndjson` |
| `FLEET_JSON` | — | текст fleet.json; записывается в `FLEET_FILE`, если файла нет (для Railway без тома) |
| `HUB_ALLOW_MOCK` | — | только для e2e: разрешить `baseUrl` мока |

Токены — любые длинные случайные строки (`openssl rand -hex 24`), два разных. Без них хаб предупреждает в логе и
работает открытым — так можно только на `127.0.0.1` для теста.

TLS хаб **не делает**: снаружи Caddy/Nginx или домен Railway. Расширения ходят только по `wss://` (токен в URL).

## Проверить fleet.json перед запуском

```
node hub/check.mjs fleet.json
```

Печатает по профилю стратегию, оплату, прокси (без пароля), цели, ошибки валидации — те же, что вернёт хаб
(422). Код выхода 1 при ошибках.

## Запуск руками (локально или на любом сервере с Node 20)

```
npm ci --omit=dev          # только ws
HUB_TOKEN=… HUB_DASH_TOKEN=… FLEET_FILE=/srv/drop/fleet.json RUNTIME_DIR=/srv/drop/runtime node hub/server.mjs
```

Проверка: `curl -s http://127.0.0.1:8765/healthz` → `{"ok":true,…}`; дашборд `http://127.0.0.1:8765/?token=<HUB_DASH_TOKEN>`.

## VPS + Caddy (рекомендуется)

Любой VPS с Ubuntu/Debian, домен `hub.example.com` → A-запись на VPS. Caddy сам получает сертификат и проксирует
WebSocket без настроек.

```bash
# 1. код и зависимости
sudo mkdir -p /srv/drop && sudo chown $USER /srv/drop
git clone https://github.com/georgii-korzion/applebot /srv/drop/app
cd /srv/drop/app && npm ci --omit=dev
cp fleet.example.json /srv/drop/fleet.json      # заполнить: профили, контакты, прокси, карты
node hub/check.mjs /srv/drop/fleet.json

# 2. systemd
sudo tee /etc/systemd/system/drop-hub.service >/dev/null <<EOF
[Unit]
Description=Apple drop hub
After=network.target
[Service]
WorkingDirectory=/srv/drop/app
Environment=HUB_TOKEN=ЗАМЕНИТЬ
Environment=HUB_DASH_TOKEN=ЗАМЕНИТЬ
Environment=HUB_PORT=8765
Environment=HUB_HOST=127.0.0.1
Environment=FLEET_FILE=/srv/drop/fleet.json
Environment=RUNTIME_DIR=/srv/drop/runtime
ExecStart=/usr/bin/node hub/server.mjs
Restart=always
User=$USER
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now drop-hub
journalctl -u drop-hub -f

# 3. Caddy
sudo apt install -y caddy
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
hub.example.com {
    reverse_proxy 127.0.0.1:8765
}
EOF
sudo systemctl reload caddy
```

Проверка снаружи: `curl -s https://hub.example.com/healthz`. Адрес для профилей: `wss://hub.example.com/ws?token=<HUB_TOKEN>`.

Правка `fleet.json` на ходу: отредактировать файл (увеличив `version`) — хаб перечитает его сам в течение 2 с и
разошлёт `CONFIG_AVAILABLE`; или `curl -X POST -H 'X-Token: <HUB_DASH_TOKEN>' https://hub.example.com/api/reload`.

### Тот же VPS, но в Docker

```bash
docker build -f hub/Dockerfile -t drop-hub .
docker run -d --name drop-hub --restart unless-stopped -p 127.0.0.1:8765:8765 \
  -v /srv/drop:/data -e HUB_TOKEN=… -e HUB_DASH_TOKEN=… drop-hub
# fleet.json лежит в /srv/drop/fleet.json (в контейнере /data/fleet.json), runtime — /srv/drop/runtime
sudo chown -R 1000:1000 /srv/drop     # процесс в контейнере идёт от пользователя node (uid 1000)
```

Образ в этом репозитории собран не был (в среде разработки нет Docker-демона) — первый `docker build` проверить на VPS.

Caddy — как выше.

## Railway

1. New Project → Deploy from GitHub repo → этот репозиторий. В настройках сервиса: **Root Directory** оставить
   корень, **Dockerfile Path** `hub/Dockerfile` (или Build Command `npm ci --omit=dev`, Start Command
   `node hub/server.mjs`).
2. Variables: `HUB_TOKEN`, `HUB_DASH_TOKEN`. `PORT` Railway задаёт сам.
3. `fleet.json` одним из способов:
   - Volume (Settings → Volumes, mount path `/data`) и `FLEET_FILE=/data/fleet.json`, `RUNTIME_DIR=/data/runtime`;
     файл залить через `railway ssh` / `railway run` или положить начальный текст в `FLEET_JSON` (см. ниже) —
     он запишется на том при первом старте, дальше редактируется там;
   - без тома: переменная `FLEET_JSON` = весь текст fleet.json (Raw Editor), `FLEET_FILE=/tmp/fleet.json`,
     `RUNTIME_DIR=/tmp/runtime`. Состояние при редеплое теряется (записи заказов остаются у профилей и в CSV —
     скачать после дропа).
4. Settings → Networking → Generate Domain → `xxx.up.railway.app`. Адрес для профилей:
   `wss://xxx.up.railway.app/ws?token=<HUB_TOKEN>`, дашборд `https://xxx.up.railway.app/?token=<HUB_DASH_TOKEN>`.

Railway «усыпляет» сервис без трафика на бесплатных планах — профили держат WS и шлют PING, но на день дропа
лучше платный план или VPS.

## Что видно на дашборде и в API

- `GET /?token=…` — дашборд: openAt и отсчёт, онлайн/всего, первый OPEN, заказы; кнопки Start все / Stop все /
  Prepare все / Проверить IP / все →hold / →refresh / Разослать конфиг / CSV / Сбросить (все массовые — с
  подтверждением); таблица сервер×профиль (онлайн, стратегия, IP·страна, cfg v, состояние, OPEN +с, Billing +с,
  номер заказа, рефрешей/404) с кнопками в строке; таблица заказов; лог с фильтром по профилю.
- `GET /api/state`, `GET /api/orders.csv`, `POST /api/command {target, cmd, args}` — `target`: `all`, `<profileId>`,
  `server:<srv>`; `cmd`: `start|stop|prepare|cleanBag|reloadConfig|setStrategy|focus|checkIp`
  (`args: {strategy: 'hold'|'refresh'}` для setStrategy); `POST /api/reload`; `POST /api/reset` (профили и лог,
  fleet.json не трогает). Все — с `?token=<HUB_DASH_TOKEN>` или `X-Token`.
- `GET /config/<profileId>?token=<HUB_TOKEN>` — конфиг профиля; 404 — нет в fleet.json; 422 `{errors}` — не проходит
  валидацию; заголовок `x-cfg-version`.
- WS `/ws?token=<HUB_TOKEN>` — расширения; `Origin` только `chrome-extension://…` или пустой; второе подключение
  того же profileId закрывает первое (предупреждение на дашборде).

## Безопасность

- `fleet.json` содержит карты и пароли прокси — хранить только на хабе и у владельца, в git не класть
  (`fleet.json` в `.gitignore`). После дропа стереть карты (`docs/FLEET-RUNBOOK.md`, шаг «после дропа»).
- Токен хаба виден в командной строке Chrome на серверах (`#drop=…&hub=wss://…?token=…`) — это серверы владельца,
  приемлемо; при утечке — сменить `HUB_TOKEN` и перезапустить профили (`fleet.ps1 init -Hub …` + `start`).
- Хаб и расширение маскируют пароли прокси, токены и номера карт в логах; `fleet.json` целиком хаб никуда не
  отдаёт (`/config/<id>` — только конфиг этого профиля).
