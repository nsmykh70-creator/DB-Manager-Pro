// Общие приспособления для e2e-наборов: подключения могли удалить из UI, поэтому
// ищем по виду СУБД, а если нет ни одного — создаём нужное (идемпотентно).
// Хост берётся из compose: с хоста машины имя `redis` не резолвится, но backend
// внутри Docker видит сервис по этому имени.
const REDIS_SPEC = { name: 'e2e-redis', kind: 'redis', port: 6379, database: '0' };

export function redisHost() {
  return process.env.E2E_REDIS_HOST || 'redis';
}

/**
 * Возвращает подключение Redis: по имени e2e-redis, иначе любое существующее
 * redis-подключение (с синхронизацией хоста), иначе создаёт новое.
 */
export async function ensureRedis(req, T, byName) {
  const named = byName?.['e2e-redis'];
  if (named) return named;
  const conns = await req('GET', '/api/connections', T);
  const existing = conns.find((c) => c.kind === 'redis');
  if (existing) {
    if (existing.host !== redisHost()) {
      return req('PATCH', `/api/connections/${existing.id}`, T, { host: redisHost() });
    }
    return existing;
  }
  return req('POST', '/api/connections', T, { ...REDIS_SPEC, host: redisHost() });
}

/**
 * Базу могли удалить из UI — тогда набор падает не по своей вине. Создаём её
 * заново и (для SQL) засеиваем таблицу users, которую ждут остальные наборы.
 */
export async function ensureDatabase(req, T, connId, opts = {}) {
  const name = opts.name ?? 'demo';
  const dbs = await req('GET', `/api/connections/${connId}/databases`, T);
  if (dbs.includes(name)) return false;
  console.log(`  database ${name} is missing — recreating`);
  if (opts.mongo) {
    const { MongoClient } = await import('mongodb');
    const mc = new MongoClient(`mongodb://${process.env.E2E_LOCAL_MONGO_HOST || '127.0.0.1'}:27017`);
    await mc.connect();
    await mc.db(name).collection('users').deleteMany({});
    if (opts.seedUsers !== false) {
      await mc.db(name).collection('users').insertMany([{ name: 'Ann', age: 30 }, { name: 'Bob', age: 25 }]);
    }
    await mc.close();
  } else {
    await req('POST', '/api/databases', T, { connectionId: connId, name });
    if (opts.seedUsers !== false) {
      const script = `CREATE TABLE users (id ${opts.idType ?? 'INT AUTO_INCREMENT'} PRIMARY KEY, name ${opts.colType ?? 'VARCHAR(100)'}, age INT);`
        + ` INSERT INTO users (name, age) VALUES ('Ann', 30), ('Bob', 25);`;
      await req('POST', `/api/connections/${connId}/import`, T, { format: 'sql', db: name, data: script });
    }
  }
  return true;
}
