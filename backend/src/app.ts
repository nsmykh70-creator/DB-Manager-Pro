import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { loadConfig } from './core/config.js';
import { openMeta } from './core/store.js';
import { ensureAdmin, isCurrentUser, verifyTokenPayload } from './core/auth.js';
import { register } from './plugins/registry.js';
import { mysqlDriver, mariadbDriver } from './drivers/mysql.js';
import { pgDriver } from './drivers/postgres.js';
import { sqliteDriver } from './drivers/sqlite.js';
import { mongoDriver } from './drivers/mongodb.js';
import { redisDriver } from './drivers/redis.js';
import { oracleDriver } from './drivers/oracle.js';
import { connectionsRoutes } from './routes/connections.js';
import { browseRoutes } from './routes/browse.js';
import { queryRoutes } from './routes/query.js';
import { authRoutes } from './routes/auth.js';
import { importRoutes } from './routes/import.js';
import { backupRoutes } from './routes/backups.js';
import { designRoutes } from './routes/design.js';
import { dbUserRoutes } from './routes/dbusers.js';
import { rowRoutes } from './routes/rows.js';
import { dataUndoRoutes } from './routes/dataundo.js';
import { modelRoutes } from './routes/models.js';
import { explainRoutes } from './routes/explain.js';
import { bulkRowsRoutes } from './routes/bulk.js';
import { killRoutes } from './routes/kill.js';
import { historyRoutes } from './routes/history.js';
import { ensureHistoryTable } from './core/history.js';
import { sqliteFileRoutes } from './routes/sqliteFiles.js';
import { settingsRoutes } from './routes/settings.js';
import { closeAllPools } from './core/pool.js';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { startScheduler } from './core/backups.js';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

register(mysqlDriver);
register(mariadbDriver);
register(pgDriver);
register(sqliteDriver);
register(mongoDriver);
register(redisDriver as any);
register(oracleDriver);

const PUBLIC = new Set(['/api/health', '/api/drivers', '/api/auth/login', '/api/auth/setup', '/docs', '/docs/json', '/docs/yaml']);

export async function buildApp() {
  const cfg = loadConfig();
  openMeta(cfg.metaPath);
  const app = Fastify({ logger: true });
  app.register(cors, { origin: cfg.corsOrigins });
  // multipart ОБЯЗАН быть зарегистрирован в корневом scope ДО роутов:
  // иначе req.file() в sqliteFileRoutes не будет декорирован ("req.file is not a function").
  // Лимит на КОЛИЧЕСТВО файлов/полей здесь не ставим: при его срабатывании busboy
  // обрывает поток и запрос зависает без ответа — считаем файлы в хендлере.
  app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } });
  app.register(rateLimit, { max: cfg.rateLimitMax, timeWindow: '1 minute' });
  // Заголовки безопасности на все ответы API (и на SPA, когда backend отдаёт
  // собранный frontend сам). Nginx ставит их только статике, чтобы не дублировать.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  });
// Swagger регистрируется ПЕРВЫМ плагином, а маршруты — отдельным
  // app.register() ниже. Порядок здесь принципиален.
  //
  // register() откладывает запуск плагина до ready(). Если маршруты
  // регистрировать напрямую (app.get(...)), они попадают в Fastify раньше,
  // чем стартует fastify-swagger, — и его хук onRoute их не видит. Тогда
  // /docs/json содержал 0 paths, и hideUntagged не помогал: дело было не в
  // фильтре, а в пустом списке маршрутов. Оба плагина стартуют в порядке
  // регистрации, поэтому хук swagger установлен до маршрутов.
  app.register(swagger, {
    openapi: { info: { title: 'DB Panel API', version: '0.1.0' }, servers: [{ url: 'http://localhost:3001' }] },
    // Маршруты описаны без схем (это не pydantic-проект), и по умолчанию
    // fastify-swagger скрывает всё нетегированное — из-за чего страница /docs
    // показывала «DB Panel API» и ноль маршрутов. hideUntagged: false выводит
    // фактический список эндпоинтов, какими они зарегистрированы.
    hideUntagged: false
  });
  app.register(swaggerUi, { routePrefix: '/docs', uiConfig: { docExpansion: 'list' } });
  // Serve built frontend (portable Faraja integration) at / when present
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const feDist = path.resolve(__dirname, '../../frontend/dist');
    if (existsSync(feDist) && existsSync(path.join(feDist, 'index.html'))) {
      app.register(fastifyStatic, { root: feDist, prefix: '/', wildcard: true } as any);
      app.setNotFoundHandler((req, reply) => {
        if (req.url.startsWith('/api') || req.url.startsWith('/docs') || req.url.startsWith('/assets/')) return (reply as any).callNotFound();
        return (reply as any).sendFile('index.html');
      });
    }
  } catch { /* no frontend dist — API only */ }

  // Fastify по умолчанию отвечает 400 «Body cannot be empty when content-type is
  // set to application/json» на DELETE/POST без тела, если клиент прислал
  // Content-Type: application/json. Для нашего API это ловушка: удаление БД,
  // чекпоинта, модели и т.п. не имеют тела, и любой внешний клиент (curl,
  // скрипт, интеграция) получает невнятную ошибку вместо результата.
  // Поэтому пустое тело считаем отсутствующим, а не ошибочным.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const raw = typeof body === 'string' ? body.trim() : '';
    if (!raw) { done(null, undefined); return; }
    try { done(null, JSON.parse(raw)); } catch (e) {
      done(Object.assign(new Error('Body is not valid JSON'), { statusCode: 400 }), undefined);
    }
  });
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => { done(null, body); });

  // Ошибки 4xx — это наши собственные проверки (сообщение безопасно для клиента).
  // 5xx — внутренние сбои драйверов: там текст ошибки может содержать DSN,
  // хост, фрагменты SQL и пути, поэтому наружу отдаём только нейтральный текст,
  // а детали пишем в лог.
  app.setErrorHandler((err: Error & { statusCode?: number; current?: unknown; checked?: unknown; code?: unknown }, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err }, 'request failed');
      return reply.status(status).send({ error: 'Internal server error' });
    }
    req.log.warn({ err: err.message }, 'request rejected');
    // При конфликте правки (409) отдаём актуальное состояние строки и список
    // проверенных колонок — иначе клиенту нечего показать пользователю.
    const extra: Record<string, unknown> = {};
    if (err.current !== undefined) extra.current = err.current;
    if (err.checked !== undefined) extra.checked = err.checked;
    // Машинный код ошибки: текст остаётся английским (его читают в журналах),
    // а интерфейс по коду показывает перевод. Без кода остаётся английский текст.
    if (typeof err.code === 'string' && /^[a-z0-9_]+$/.test(err.code)) extra.code = err.code;
    return reply.status(status).send({ error: err.message || 'Bad request', ...extra });
  });

  // Auth-hook: разбираем Bearer, требуем только если REQUIRE_AUTH=1
  app.addHook('onRequest', async (req) => {
    const p = req.url.split('?')[0];
    if (!p.startsWith('/api/')) return;
    if (PUBLIC.has(p)) return;
    const h = req.headers.authorization;
    if (h?.startsWith('Bearer ')) {
      try {
        const payload = verifyTokenPayload(h.slice(7), cfg.jwtSecret);
        // Промежуточный 2FA-токен живёт 5 минут и годится только на
        // подтверждение кода — везде иначе это 401, а не доступ.
        if (payload.scope === '2fa' && p !== '/api/auth/2fa/verify') {
          throw Object.assign(new Error('Two-factor confirmation required'), { statusCode: 401 });
        }
        const user = { id: payload.sub, username: payload.username, role: payload.role };
        if (!isCurrentUser(cfg.metaPath, user)) throw Object.assign(new Error('User is no longer active'), { statusCode: 401 });
        (req as unknown as { user: unknown }).user = user;
      } catch (e: unknown) {
        if (e instanceof Error && (e as { statusCode?: number }).statusCode === 401) throw e;
        throw Object.assign(new Error('Bad token'), { statusCode: 401 });
      }
    } else if (cfg.requireAuth) {
      throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    }
  });

// Маршруты регистрируются отдельным плагином — см. комментарий к swagger
  // выше: только так fastify-swagger успевает поставить свой хук onRoute до них.
  await app.register(async (routes) => {
    routes.get('/api/health', async () => ({ ok: true, ts: Date.now(), auth: cfg.requireAuth }));
    routes.get('/api/drivers', async () => ({ kinds: ['mysql', 'mariadb', 'postgres', 'sqlite', 'mongodb', 'redis', 'oracle'], implemented: ['mysql', 'mariadb', 'postgres', 'sqlite', 'mongodb', 'redis', 'oracle'] }));
    routes.get('/api/system/status', async () => {
      const os = await import('node:os');
      const total = os.totalmem(), free = os.freemem(), used = total - free;
      const cpus = os.cpus();
      let idle = 0, totalTick = 0;
      for (const c of cpus) { for (const t in c.times) { totalTick += (c.times as any)[t]; } idle += c.times.idle; }
      const cpuLoad = cpus.length ? Math.round((1 - idle / totalTick) * 100) : 0;
      return { cpuLoad, ramUsed: used, ramTotal: total, uptimeSec: os.uptime(), platform: os.platform(), arch: os.arch(), loadAvg: os.loadavg() };
    });

    authRoutes(routes, cfg);
    connectionsRoutes(routes, cfg);
    browseRoutes(routes, cfg);
    queryRoutes(routes, cfg);
    importRoutes(routes, cfg);
    backupRoutes(routes, cfg);
    designRoutes(routes, cfg);
    dbUserRoutes(routes, cfg);
    rowRoutes(routes, cfg);
    dataUndoRoutes(routes, cfg);
    modelRoutes(routes, cfg);
    explainRoutes(routes, cfg);
    bulkRowsRoutes(routes, cfg);
    killRoutes(routes, cfg);
    sqliteFileRoutes(routes, cfg);
    settingsRoutes(routes, cfg);
    historyRoutes(routes, cfg);
  });
  ensureHistoryTable(cfg.metaPath);

  // seed admin (async, не блокируем старт)
  void ensureAdmin(cfg.metaPath, cfg.adminUser, cfg.adminPassword, cfg.adminPasswordIsDefault).catch((e) => app.log.error(e));

  // планировщик бэкапов: тикает каждые 30с
  const stopScheduler = startScheduler(cfg.metaPath, cfg.encryptionKeyHex, app.log);
  app.addHook('onClose', async () => { stopScheduler(); await closeAllPools(); });

  return app;
}
