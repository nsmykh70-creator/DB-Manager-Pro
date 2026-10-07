# DB Manager Pro × FarajaWebServer

Интеграция панели в портативный стек FarajaWebServer вместо phpMyAdmin.

## Как это устроено

- Панель лежит рядом с программой: `<faraja>/mydbroot/` (backend + frontend).
- Лаунчер (`MiniServer.py`) запускает backend через свою node-инфраструктуру
  (`node_server_start("dbmanager", ..., "dist/index.js", port)`, порт из
  `config/server.json` → `mydbroot_port`, дефолт 3001) и открывает браузер
  с одноразовым билетом `http://127.0.0.1:3001/?ticket=...`.
- Фронт при старте меняет `?ticket=` на JWT (`POST /api/auth/sso/exchange`)
  и чистит URL. Без билета — обычный экран входа.
- Backend при отсутствии `frontend/dist` работает как API; собранный фронт
  отдаёт сам (`/`), отдельный веб-сервер не нужен.

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

Раскладка данных:

- `META_PATH` → `<faraja>/data/dbmanager/meta.db`
- `SQLITE_DIR` → `<faraja>/www/sqlite` (файлы видны и в панели, и в проводнике)

## SSO-билеты

- `POST /api/auth/sso` `{secret, username}` → `{ticket}` (TTL 60 с, одноразовый).
- `POST /api/auth/sso/exchange` `{ticket}` → `{token, user}` (либо
  `{need2fa, tempToken}`, либо `{mustChangePassword: true}` — как login).
- Без `FARAJA_SSO_SECRET` обе ручки отвечают 404 и неотличимы от
  отсутствующих маршрутов.
- Проверка: `npm run e2e:faraja-sso` (нужен поднятый backend).

## Сторона лаунчера (патч `faraja-dbmanager.patch` в корне FarajaWebServer)

- `DEFAULT` += `mydbroot_port: 3001`.
- Кнопка панели действий: `phpMyAdmin` → `DB Manager Pro`
  (`dbmanager_open`: старт при необходимости + SSO-билет в браузер).
- `START ALL` поднимает панель best-effort; `STOP ALL` гасит её вместе
  с остальными node-серверами (`stop_node`).
- Удалено: кнопка/роут phpMyAdmin, `Alias /phpmyadmin`, `_setup_pma_storage`,
  установка компонента, упоминания в мастере/помощи (6 языков), `www`-ссылки,
  блок `phpmyadmin` в `components.json`, упоминания в README.
- Применение: `git apply faraja-dbmanager.patch` в репозитории FarajaWebServer,
  затем сборка `build.bat` (попадёт в следующий `FarajaWebServerPRO.exe`).
  Каталог `<faraja>/mydbroot` кладётся рядом с exe и в поставку НЕ вшивается
  (`build.bat` пакует только `config/www/assets/components.json/requirements.txt`).
  Для запуска панели нужны: `backend/dist`, `frontend/dist`, `backend/.env`
  и prod-зависимости (`npm ci --omit=dev -w backend`, ~100 МБ — dev-пакеты
  и `frontend/node_modules` на рантайм не нужны).
