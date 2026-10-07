# DB Manager Pro × FarajaWebServer

Интеграция панели в портативный стек FarajaWebServer вместо phpMyAdmin.

## Как это устроено (лаунчер V16)

- Панель лежит рядом с программой: `<faraja>/mydbroot/` (backend + frontend).
- Лаунчер поднимает backend сам (`start_mydbroot`: проверка
  `backend/package.json` и `node.exe`, автосборка `tsc` при отсутствии
  `backend/dist/index.js`, `Popen node dist/index.js`, ожидание порта,
  HTTP-сидинг пресетов) и открывает браузер на `http://127.0.0.1:3001/`
  (без билета — обычный вход; вход по билету тоже поддерживается фронтом).
- Backend при отсутствии `frontend/dist` работает как API; собранный фронт
  отдаёт сам (`/`), отдельный веб-сервер не нужен.
- Важно: V16 форсирует через окружение процесса `PORT` (из `mydbroot_port`),
  `REQUIRE_AUTH=0` и `META_PATH=<mydbroot>/backend/data/meta.db` — значения
  из `backend/.env` для этих трёх ключей игнорируются. `SQLITE_DIR` из `.env`
  действует (по умолчанию `www/sqlite`).
- Реконструкция логики V16 по дизассемблеру:
  `faraja-v16-mydbroot.reference.py` в корне FarajaWebServer (reference-only,
  не исходник).

## Первичная настройка (один раз)

```console
node faraja-bootstrap.mjs   # backend/.env: порт, META_PATH, SQLITE_DIR, секреты
node faraja-seed-presets.mjs  # подключения MariaDB/MySQL/PostgreSQL/Redis/MongoDB (Faraja)
npm run build -w backend && npm run build -w frontend
```

`faraja-bootstrap.mjs` не затирает существующие `ENCRYPTION_KEY`,
`JWT_SECRET`, `ADMIN_*` — только дописывает недостающее. Зеркало SSO-секрета
для лаунчера: `<faraja>/config/dbmanager-sso.txt` (основной источник —
`backend/.env`, `FARAJA_SSO_SECRET`).

Раскладка данных (единая с V16):

- `META_PATH` → `<mydbroot>/backend/data/meta.db` (форсирует лаунчер)
- `SQLITE_DIR` → `<faraja>/www/sqlite` (файлы видны и в панели, и в проводнике)

## SSO-билеты

- `POST /api/auth/sso` `{secret, username}` → `{ticket}` (TTL 60 с, одноразовый).
- `POST /api/auth/sso/exchange` `{ticket}` → `{token, user}` (либо
  `{need2fa, tempToken}`, либо `{mustChangePassword: true}` — как login).
- Без `FARAJA_SSO_SECRET` обе ручки отвечают 404 и неотличимы от
  отсутствующих маршрутов.
- Проверка: `npm run e2e:faraja-sso` (нужен поднятый backend).

## Сторона лаунчера (V16, исходник утерян — правится через реконструкцию)

Актуальный `FarajaWebServerPRO.exe` (V16) уже содержит все 14 сервисов
(Apache, MariaDB, MySQL, PHP, PostgreSQL, Redis, Nginx, MongoDB, Memcached,
Docker, Node.js, MyDbRoot, CloudBeaver, Mailpit) и полную интеграцию MyDbRoot
(старт/стоп/рестарт/open, автосборка `tsc`, HTTP-сидинг пресетов
`MariaDB/MySQL/PostgreSQL/MongoDB/SQLite (Faraja)`, демо-`faraja_demo.sqlite`).
phpMyAdmin в V16 отсутствует полностью. Отдельный патч не требуется;
`faraja-v16-mydbroot.reference.py` в корне FarajaWebServer — точка входа
для будущих правок V16. Для запуска панели рядом с exe нужны: `mydbroot/`
с `backend/dist`, `frontend/dist`, `backend/.env` и prod-зависимостями
(`npm ci --omit=dev -w backend`; dev-пакеты и `frontend/node_modules`
на рантайм не нужны).
