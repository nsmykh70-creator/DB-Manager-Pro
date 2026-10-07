# MyDbRoot — Аудит демо-данных и неработающих функций + план доведения до рабочего состояния

Дата: 24.09.2026. Номера строк — на момент аудита, могут съезжать при правках.
Легенда: `[ДЕМО]` — выдуманные данные; `[СТАБ]` — кнопка/функция-обманка (только тост);
`[ГЕП]` — не реализовано/падает для отдельных СУБД; `[БАГ]` — неверное поведение.
Отметка `✅ ИСПРАВЛЕНО` — уже починено в ходе текущей сессии.

---

## 0. Инфраструктура (проверено запуском, 25.09.2026)

Ниже — фактическое состояние после инфраструктурного прохода; каждое утверждение
прогнано командой, а не прочитано. Разделы 1–3 ниже описывают продукт и остаются в силе.

### 0.1 Было сломано и починено
| # | Проблема | Где | Как проявилось | Статус |
|---|---|---|---|---|
| 1 | `frontend` просил `typescript: ^7.0.2`, `backend` — `^5.6.3` | `frontend/package.json` | В workspaces компиляторов было два: вложенный 7.0.2 (20 лишних `@typescript/*` пакетов) и корневой 5.9.3. `npx tsc` в CI и `npm run lint -w frontend` проверяли один код разными компиляторами | ✅ `^5.9.3`, один компилятор, 506 пакет в lock |
| 2 | 30 записей lock помечены `dev: true`, хотя esbuild/tsx/`@types/react` лежат в `dependencies` фронта | `package-lock.json` | `npm ci` в проде тянул бы dev-пакеты как runtime | ✅ пересобрано `npm install --package-lock-only` |
| 3 | `react-is` не объявлен, но импортируется `recharts` (`Monitoring.tsx:2`) | `frontend/package.json` | `vite build` падал: `Rolldown failed to resolve import "react-is"`, README обещал «vite build — 0» | ✅ добавлен `react-is: ^19.2.0` |
| 4 | `esbuild: ^0.25.0` во фронте vs `peerOptional esbuild ^0.27 \|\| ^0.28` у `vite@8` | `frontend/package.json` | `docker compose build frontend` → `ERESOLVE`. Локально спасало только то, что workspaces поднимал 0.28.2 в корень | ✅ `^0.28.0` |
| 5 | В CI не было сервисов **mariadb** и **redis** | `.github/workflows/ci.yml` | `seed-dbs` сеет `127.0.0.1:3307`, `e2e-dbs` ждёт `e2e-maria`, `e2e-redis` ждёт `6379` → падение | ✅ оба сервиса + healthcheck'и |
| 6 | Никто не создавал `ro_user` / `e2e_editor` | 8 сюит e2e | На чистом `META_PATH` (то есть в CI) `audit/backup/dbusers/design/grants/history/poolkill/rows` получали 401 | ✅ `e2e-users.mjs`, идемпотентно, первым в `e2e:all` |
| 7 | CI запускал backend через `tsx watch` в фоне | `.github/workflows/ci.yml` | Watch-режим + `&` без ожиданияhealth — гонка и «висящий» процесс | ✅ `node backend/dist/index.js` + опрос health + `trap` на cleanup |
| 8 | nginx: дефолт `client_max_body_size 1m` | `frontend/nginx.conf` | 413 раньше бэкенда на multipart-загрузке SQLite-файлов (лимит 100 MB) | ✅ `100m` (проверено: 3 MB файл проходит) |
| 9 | nginx: дефолтные 60s таймауты, буферизация стрима | `frontend/nginx.conf` | Долгие запросы (`QUERY_TIMEOUT_MS=30000`) и стриминг экспорта/бэкапов рвались на 60s и копились в буфер | ✅ `300s`, `proxy_buffering off` |
| 10 | `/docs` не проксировался | `frontend/nginx.conf` | Через nginx `:8080/docs` отдавал SPA-shell вместо Swagger UI | ✅ `location /docs` → backend |
| 11 | `NODE_ENV` не выставлялся нигде | оба `Dockerfile`, `docker-compose.yml` | Продакшен-guard в `core/config.ts` (проверка `JWT_SECRET`/`ENCRYPTION_KEY`/`ADMIN_PASSWORD`) никогда не срабатывал | ✅ `ENV NODE_ENV=production` + healthcheck-гейтинг `depends_on` |
| 12 | Удалённое legacy попадало в git и в docker build context | `.gitignore`, `.dockerignore` | `server.mjs`, `frontend/src.bak.real`, `design/` | ✅ удалены, правила добавлены |

### 0.2 Удалено как мёртвое (проверено ссылками перед удалением)
- **`server.mjs`** — прототип на Express + `node:sqlite`, порт 8787, хранилище
  `data/connections.json`. Ни в `package.json` scripts, ни в Dockerfile, ни в CI,
  ни в compose его не было; ни один файл его не импортировал.
- **`frontend/src.bak.real/`** — снапшот `frontend/src` до перехода на Windows-shell UI.
  Не попадал ни в `tsc` (`frontend/tsconfig.json` включает только `src` и `vite.config.ts`),
  ни в сборку (`index.html` → `/src/main.tsx`). В `.dockerignore` не был исключён,
  то есть попадал в build context.
- **`design/`** — отдельный прототип «DB Manager Pro» со своим `package.json`/`bun.lock`
  и двумя zip. Не npm-workspace, нигде не импортируется. Внимание: `e2e-design.mjs`
  проверяет **роуты** `backend/src/routes/design.ts` (конструктор таблиц) и к этому
  каталогу отношения не имеет.

Не удалялось: `backend/data/*` (рабочий `meta.db`, `test.db`, `meta.db.before-encryption-rotation`),
`backend/dist`, `frontend/dist` — это рабочие артефакты, они в `.gitignore`, но на диске нужны.

### 0.3 Проверено фактически
```
npm ci --dry-run                       # exit 0, lock валиден
npm run typecheck                      # backend + frontend, 0 ошибок
npm run build -w frontend              # built in ~19s
docker compose config --quiet          # exit 0
docker compose build backend frontend  # оба образа собрались
docker compose up -d                   # 5 БД Healthy -> backend Healthy -> frontend Started
nginx -t (в контейнере nginx:alpine)   # syntax is ok
seed:dbs + e2e:all (с нуля)            # 14/14 сюит ALL GREEN, exit 0
```

### 0.4 Найдено, но НЕ исправлено (вне инфраструктурного скоупа)
1. **Лимит JSON-тел — 1 MiB.** `Fastify({ logger: true })` без `bodyLimit` режет тело
   на 1 MiB, хотя README обещал «10M импорт». Воспроизведено: 2 MB POST → `413
   Request body is too large` и напрямую на `:3001`, и через nginx (nginx тут ни при
   чём — проверено). Лимит multipart в 100 MB работает. Фикс — `bodyLimit` при создании
   app, но это уже изменение поведения API, а не инфраструктуры.
2. **`ident()` в README описан как `[A-Za-z0-9_]`**, фактически `helpers.ts` допускает
   `\p{L}` (кириллица). Расхождение только в документации.
3. **В `frontend/package.json` лежат неиспользуемые зависимости** (`express`, `dotenv`,
   `mysql2`, `pg`, `mongodb`, `@google/genai`, `motion`). В `dependencies`, поэтому
   попадают в production-образ nginx-сборки. `mysql2`/`pg`/`mongodb` дублируют то, что
   и так подтягивается из `backend` для `seed-dbs`/`e2e`. Удаление безопасно, но это
   отдельная чистка манифеста.
4. **`frontend/package.json` → `clean` использует `rm -rf`**, что не работает в `cmd.exe`
   (Windows без git-bash). Нужен `rimraf` или node-скрипт.

---

## 1. Фронтенд (`frontend/src`)

### 1.1. Monitoring.tsx — экран целиком демо
- `[ДЕМО]` `Monitoring.tsx:5-23` — массивы `cpuData` (10:00–10:30), `queriesData` (qps 120–250) для графиков.
- `[ДЕМО]` `Monitoring.tsx:55-88` — карточки: CPU `45%`, RAM `6.2/16 GB`, QPS `140/сек`, соединения `84/500`.
- `[СТАБ]` `Monitoring.tsx:29` — пропс `connId` принимается, но не используется, API не вызывается.

### 1.2. TableView.tsx — локальные данные вместо API
- `[ДЕМО]` `:31-38` — колонки `id/username/email/password/created_at/updated_at` в табе «Структура».
- `[ДЕМО]` `:50-53` — счётчики под-табов `3,6,1`.
- `[БАГ]` `:410-443` — табы Индексы/Привилегии/SQL показывают те же поля (меняется только заголовок).
- `[ДЕМО]` `:134-151` — строка `admin/admin@test.com`, кнопки «Добавить запись» (`user_${id}`) и «Обновить» — всё локально.
- `[ДЕМО]` `:199-206` — триггер `before_user_update`, связь `fk_user_role` захардкожены.
- `[СТАБ]` `:85-128,210-231,642-700,775-777,865-913` — Сохранить значения/колонку/связь/триггер, PK-тоггл, удаление поля/строки/связи/триггера: только `setState` + тост.
- `[СТАБ]` `:296-298` — «Клонировать»: только тост.
- `[БАГ]` `:301-310` — «Экспорт» упаковывает в Blob текст SQL-запроса, а не данные.
- `[БАГ]` `:795` — таб Индексы: статичная строка `PRIMARY/BTREE/Да/id`.
- `[БАГ]` `:428,445` — чекбоксы структуры без `onChange/checked`.

### 1.3. MainContent.tsx — частично почищено ранее
- ✅ ИСПРАВЛЕНО: SQL-редакторы стартуют пустыми, кнопка «Выполнить» большой вкладки реально выполняет, кнопка «Очистить» добавлена.
- `[ДЕМО]` `:95-99` — `mockLogs` (`2025-05-16/admin/SELECT...`).
- `[ДЕМО]` `:104-109` — `systemEvents` (Checkpoint, 99.4%, testdb).
- `[СТАБ]` `:291-314` — «Восстановить примеры» возвращает те же моки.
- `[СТАБ]` `:317-338` — «Сгенерировать» событие: случайный текст (`binlog.000042`).
- `[СТАБ]` `:361-375` — глобальный поиск: `setTimeout` → всегда `[{users:3},{orders:1}]`.
- `[СТАБ]` `:859` — «BulkExport»: только тост.
- `[СТАБ]` `:1460` — «Начать экспорт»: только тост (формат выбирается, но не используется).
- `[СТАБ]` `:1470` — дропзона импорта: тост «Имитация выбора файла».
- `[БАГ]` `:944-948` — селект «Строк на странице 25/50/100» без `value/onChange`.
- `[СТАБ]` `:1267` — «Сохранить» запрос в шаблоны: только тост (шаблонов нет).
- `[СТАБ]` `:1231` — «Код скопирован»: тост без `clipboard.writeText`.

### 1.4. Header.tsx — частично почищено ранее
- ✅ ИСПРАВЛЕНО: уведомления — реальные из `/api/audit`, «прочитаны все» скрывает список.
- `[ДЕМО]` `:479,486-487` — профиль `admin/Admin User/admin@dbmanager.pro` захардкожен.
- `[СТАБ]` `:493` — Logout: только тост (сессии и так нет — `REQUIRE_AUTH=0`, см. п.3.5).

### 1.5. SettingsModal.tsx — все табы без бэкенда
- `[СТАБ]` `:27-29` — «Сохранить»: тост + закрыть, ничего не persists (включая тосты/уведомления — они живут только в памяти!).
- `[ДЕМО]` `:96,100-104,129,170,194,203-206,211` — название проекта, часовой пояс, чекбоксы, таймаут сессии, расписание, S3-плейсхолдер: неуправляемые контролы.
- `[СТАБ]` `:188` — 2FA: тост «Инструкции отправлены».
- `[СТАБ]` `:213` — «Создать бэкап»: только тост (бэкенд `/api/backups` существует!).
- `[СТАБ]` `:223,238-245` — «Пригласить», таблица `admin@dbmanager.pro/dev@dbmanager.pro`, «Пользователь удален»: всё локально (бэкенд `/api/auth/users` существует!).

### 1.6. Sidebar.tsx — мелочи
- `[СТАБ]` `:74,152,273` — `showDocs` никогда не `true`: `DocsModal` недостижим.
- `[СТАБ]` `:199` — «Как подключить?»: тост вместо помощи.

### 1.7. Модалки колонок
- `[ДЕМО]` `EditColumnModal.tsx:19`, `QuickValueEditorModal.tsx:20` — `activeDb='testdb'` по умолчанию.

---

## 2. Бэкенд (`backend/src`)

### Уже исправлено в текущей сессии ✅
- Пулы MySQL/PG: ключ включает БД; серверные операции не зависят от default-БД; табличные операции PG идут в выбранную БД.
- `POST /databases`: ветки MongoDB/MySQL/MariaDB/PostgreSQL/SQLite + валидация имён + защита системных БД.
- MongoDB: URI без `:@` при пустом юзере; `serverSelectionTimeoutMS: 5000` везде.
- T-SQL-транслятор (`IDENTITY/GETDATE/[name]/NVARCHAR`, инлайн-FK) в `/query` и импорте.
- Мульти-стейтменты в `query()` MySQL/SQLite; fallback контекста БД в `query()`.
- Кириллические идентификаторы (`ident()` → `\p{L}`).

### 2.1. MySQL/MariaDB (`drivers/mysql.ts`)
- `[ГЕП]` `:121` — `execScript` игнорирует `db`, без fallback при удалённой default-БД.
- `[ГЕП]` `:256,264,271` — `createDbUser/dropDbUser/listGrants` отбрасывают `db`.
- `[БАГ]` `:67` — `getPage`: фильтр только `col=val` через LIKE, остальное молча игнорируется.

### 2.2. PostgreSQL (`drivers/postgres.ts`)
- ✅ ИСПРАВЛЕНО: `grant`/`revoke`/`listGrants` больше не ходят в служебную БД `postgres`.
  Раньше пул всегда создавался на `database: 'postgres'`, а цель — `public.<table>`, поэтому
  грант на таблицу рабочей БД падал в `500` с `42P01 relation "public.users" does not exist`.
  Теперь берётся запрошенная БД (`db || cfg.database`); `information_schema` в PG
  per-database, поэтому `listGrants` переведён на неё же. Схемы кроме `public` не поддержаны.
- `[ГЕП]` `:35,80` — `getPage`/поиск: `sort/filter` из роута игнорируются.
- `[ГЕП]` — `grant/revoke` принимают `table`, но не `schema` (всегда `public`).
- `[ГЕП]` `:26` — `listTables` только `schemaname='public'`.
- `[ГЕП]` `:45` — `query` без `splitStatements` (полагается на нативный multi PG — работает, но inconsistent).

### 2.3. SQLite (`drivers/sqlite.ts`)
- `[ГЕП]` — пользователи/гранты/kill: 400 `not supported` по дизайну (SQLite их не имеет — ок, но UI должен это учитывать).
- `[БАГ]` `:151` — `getStatus`: `statSync` без try (при удалённом файле — `ENOENT`, сейчас маскируется fallback'ом роута).

### 2.4. MongoDB (`drivers/mongodb.ts`)
- `[ГЕП]` — `execScript` бросает исключение (импорт .sql невозможен), `alterTable`/`killQuery` — тоже; restore SQL-бэкапов невозможен.
- `[ГЕП]` — `getRelations` возвращает `[]`.
- `[БАГ]` — `listDbUsers/listGrants` лезут в хардкод-БД `'demo'` при пустой default-БД.
- `[БАГ]` — `getPage` игнорирует `sort/filter`.

### 2.5. Redis (`drivers/redis.ts`) — подключение удалено из UI по требованию, драйвер остаётся
- `[ДЕМО]` `:35` — `listDatabases` возвращает `0..15` без соединения.
- `[БАГ]` `:38` — `listTables` режет до 500 ключей без флага `truncated`.
- `[БАГ]` `:186` — `updateRow` игнорирует `filter` (`matched:1` всегда).
- `[СТАБ]` `:162` — `createTable` фиктивная (`set`+`del`).
- `[ГЕП]` — нет `execScript/importRows/streamRows/alterTable`, пользователи/гранты/kill — исключения.

### 2.6. Роуты/ядро
- `[БАГ]` `browse.ts:18,22,80` — ошибки `listDatabases`/`getStatus` глотаются (`[]`/fallback): реальная причина не видна. Частично нужно (недоступные серверы), но стоит логировать.
- `[БАГ]` `core/types.ts:56` — `readOnly`-защита обходится ведущим комментарием (`/*x*/ DELETE`) или `WITH ... DELETE`.
- `[БАГ]` `connections.ts` (create/drop через прямые коннекты) — имена БД через `replaceAll` без `ident()` (кроме `POST /databases`).

---

## 3. План доведения до рабочего состояния

### P0 — честность интерфейса (1–2 дня)
1. **TableView на реальные API**: структура/данные уже грузятся (`schema`/`rows` работают); переписать вкладки Индексы/Привилегии/SQL/Триггеры/Связи: реальные `SHOW INDEX`/`grants` есть на бэкенде (`/schema` отдаёт `indexes` для MySQL); триггеры/связи — честный `getRelations` (MySQL/PG) + `SHOW TRIGGERS`.
2. **CRUD строк по-настоящему**: `insertRow/updateRows/deleteRows` на бэкенде готовы — привязать кнопки Добавить/Сохранить/Trash (сейчас локальный `filter` + тост).
3. **Убрать остатки демо**: `mockLogs`, `systemEvents`, глобальный поиск (заменить реальным поиском по `information_schema` ИЛИ честно выключить с пометкой), `testdb`-дефолты в модалках, хардкод профиля.
4. **Кнопки без API**: BulkExport/Export-таб → реальный `/export` (бэкенд готов); Copy → `clipboard.writeText`; Import-дропзона → `/import` (бэкенд готов); «Сохранить в шаблоны» → `/history` (бэкенд готов) либо убрать.

### P1 — настройки и пользователи (2–3 дня)
5. **SettingsModal → persistence**: общий KV-стор на бэкенде (`GET/PATCH /api/settings`, таблица `settings` в meta.db): название, тема/тосты (сейчас в памяти), таймауты, бэкап-расписание.
6. **Бэкапы по-настоящему**: фронт → `POST /api/backups/schedules|run` (бэкенд готов: mysqldump/pg_dump/sqlite-copy/mongo-json).
7. **Пользователи**: фронт-таб → `/api/auth/users` CRUD (бэкенд готов); Logout спрятать при `REQUIRE_AUTH=0`.
8. **Monitoring**: фронт → `/api/system/status` (CPU/RAM уже есть) + per-conn `serverStatus` (QPS/threads уже есть) + графики из polling; убрать хардкод.

### P2 — паритет драйверов и hardening (3–5 дней)
9. **PG**: `sort/filter` в `getPage` ~~`grant/revoke` с `db/table`~~ *(сделано, см. §2.2)*, схемы кроме `public` (выбор схемы в UI).
10. **MySQL**: fallback `execScript` без default-БД; `db` в user-менеджменте; честный `filter` в `getPage` (белый список операторов) вместо молчаливого LIKE.
11. **Mongo**: `db` из JSON-запроса (`{"db":...}`), убрать хардкод `'demo'`, `sort/filter` в `getPage`, CRUD коллекций (create/drop collection через UI вместо `alterTable`-заглушки).
12. **Безопасность**: `assertWritable` — стрипать комментарии перед проверкой; `ident()` на все интерполяции имён в `connections.ts`; `decodeURIComponent(table)` в `import.ts`.
13. **Наблюдаемость**: логировать проглоченные ошибки `browse.ts` (warn), вернуть `truncated`/totals где режется выдача (ER 100 таблиц, Redis 500 ключей).

### P3 — опционально
14. Redis UI (удалён по требованию; драйвер и 400-заглушки на месте — вернуть одной строкей, если понадобится).
15. DocsModal: либо привязать кнопку, либо удалить мёртвый код.
16. Селект «Строк на странице» привязать к `pageSize` (сейчас декоративный).
17. Поднять `bodyLimit` у Fastify до заявленных 10 MB на импорт (см. §0.4 п.1).
18. Вычистить неиспользуемые зависимости фронта и починить `clean` под Windows (см. §0.4 п.3–4).

---

## 4. Правки в самих e2e (баги тестов, не продуктов)

Обнаружились только после того, как CI/локальный прогон реально дошёл до этих сюит.

- `e2e-export.mjs` — ожидал `statements === N + 2`, получал `N + 3`. Дамп
  `export?format=sql` самодостаточный и начинается с `CREATE TABLE IF NOT EXISTS`,
  так что скрипт = `DROP` + `CREATE big2` + `CREATE`(из дампа) + `N` × `INSERT`.
  Проверка round-trip по количеству строк (`COUNT(*) = 5000`) проходила и раньше —
  падала только счётчик. Ожидание исправлено на `N + 3`.
- `e2e-sqlitefiles.mjs` — временное подключение указывало на **тот самый** файл, что был
  загружен и который сюит потом проверяет. `DELETE /api/connections/:id` для sqlite делает
  `rmSync(filePath)`, то есть удаление подключения стирало фикстуру, и следующие проверки
  (`ro delete blocked`, `delete`, `gone`) падали с 404. Теперь подключение получает
  собственную копию, плюс добавлена проверка, что файл действительно исчез.
- `e2e-sqlitefiles.mjs` — путь к временному файлу был зашит как
  `C:\Users\<user>\AppData\...`; на Linux в CI это создало бы каталог с буквальным
  именем. Заменено на `os.tmpdir()`.
- `e2e-users.mjs` (новый) — идемпотентные фикстуры `ro_user`/`e2e_editor` с проверкой
  роли после создания; раньше 8 сюит молча рассчитывали на локальную `meta.db`.

**Порядок внедрения: P0 → P1 → P2.** Каждый пункт независимо проверяем: действие в UI → 200 от API → видимое изменение данных.
