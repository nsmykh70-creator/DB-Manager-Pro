import { ensureRedis } from './e2e-fixtures.mjs';
// E2E нормализованной модели схемы: getSchema/GET /er отдают одинаковый формат
// для всех драйверов, FK содержат имя констрейнта и правила, дамп SQL сохраняет
// индексы и внешние ключи.
const BASE = process.env.E2E_BASE || 'http://localhost:3001';
const DB_HOST = process.env.E2E_DB_HOST || '';
const MYSQL_HOST = process.env.E2E_MYSQL_HOST || DB_HOST || 'mysql';
const MARIADB_HOST = process.env.E2E_MARIADB_HOST || DB_HOST || 'mariadb';
const PG_HOST = process.env.E2E_PG_HOST || DB_HOST || 'postgres';
let failures = 0;

async function req(method, path, token, body) {
  const headers = { ...(token ? { authorization: `Bearer ${token}` } : {}) };
  let payload;
  if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(BASE + path, { method, headers, body: payload });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${j.error ?? JSON.stringify(j)}`);
  return j;
}

function check(name, cond, extra = '') {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' | ' + extra : ''));
  if (!cond) failures++;
}

const login = await req('POST', '/api/auth/login', null, { username: 'admin', password: process.env.ADMIN_PASSWORD || '' });
const T = login.token;
const conns = await req('GET', '/api/connections', T);
const byName = Object.fromEntries(conns.map((c) => [c.name, c]));

/** Приводит чужую выдачу к нашей модели — так же, как это делает UI. */
function hostOf(c) {
  if (c.name === 'e2e-mysql') return MYSQL_HOST;
  if (c.name === 'e2e-maria') return MARIADB_HOST;
  if (c.name === 'e2e-pg') return PG_HOST;
  return c.host;
}
async function syncHost(c) {
  if (c.host !== hostOf(c)) await req('PATCH', `/api/connections/${c.id}`, T, { host: hostOf(c) });
  return { ...c, host: hostOf(c) };
}

const REQUIRED_COLUMNS = ['name', 'type', 'nullable', 'primary', 'autoInc', 'default', 'ordinal', 'comment', 'extra'];
function checkModel(name, schema) {
  const cols = schema?.columns;
  const shape = schema && schema.kind && Array.isArray(cols) && Array.isArray(schema.indexes)
    && Array.isArray(schema.foreignKeys) && Array.isArray(schema.triggers) && typeof schema.extra === 'object';
  check(`${name} TableSchema shape`, shape, `keys=${Object.keys(schema ?? {}).join(',')}`);
  check(`${name} column fields`, Array.isArray(cols) && cols.every((c) => REQUIRED_COLUMNS.every((k) => k in c)), JSON.stringify(cols?.[0] ?? {}).slice(0, 160));
  check(`${name} ordinals`, Array.isArray(cols) && cols.every((c, i) => c.ordinal === i + 1), JSON.stringify(cols?.map((c) => c.ordinal)));
}

// --- MySQL/MariaDB: таблица с UNIQUE, составным индексом, FK и триггером
for (const key of ['mysql', 'maria']) {
  const c = await syncHost(byName[`e2e-${key}`]);
  const db = 'demo';
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: 'DROP TABLE IF EXISTS ms_emp' });
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: 'DROP TABLE IF EXISTS ms_dept' });
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: 'CREATE TABLE ms_dept (id INT PRIMARY KEY, title VARCHAR(50))' });
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: 'CREATE TABLE ms_emp (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(50) NOT NULL, dept_id INT, email VARCHAR(120) UNIQUE, INDEX idx_emp_name (name), KEY (dept_id, name))' });
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: 'ALTER TABLE ms_emp ADD CONSTRAINT fk_emp_dept FOREIGN KEY (dept_id) REFERENCES ms_dept (id) ON DELETE CASCADE ON UPDATE RESTRICT' });
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: 'CREATE TRIGGER trg_emp_bi BEFORE INSERT ON ms_emp FOR EACH ROW SET @x = NEW.name' });

  const schema = await req('GET', `/api/connections/${c.id}/${db}/ms_emp/schema`, T);
  checkModel(`${key}`, schema);
  const id = schema.columns.find((col) => col.name === 'id');
  check(`${key} autoInc detected`, id?.autoInc === true && id?.primary === true, JSON.stringify(id));
  const name = schema.columns.find((col) => col.name === 'name');
  check(`${key} not null`, name?.nullable === false, JSON.stringify(name));
  const email = schema.columns.find((col) => col.name === 'email');
  check(`${key} no phantom default`, email?.default === null, String(email?.default));
  const multi = schema.indexes.find((ix) => ix.columns.length > 1);
  check(`${key} composite index`, Array.isArray(multi?.columns) && multi.columns.join(',') === 'dept_id,name', JSON.stringify(schema.indexes.map((ix) => ix.name)));
  check(`${key} primary flag`, schema.indexes.some((ix) => ix.primary === true && ix.columns.includes('id')), '');
  const fk = schema.foreignKeys.find((f) => f.name === 'fk_emp_dept');
  check(`${key} fk full`, fk?.columns.join(',') === 'dept_id' && fk?.refTable === 'ms_dept' && fk?.refColumns.join(',') === 'id' && fk?.onDelete === 'CASCADE' && fk?.onUpdate === 'RESTRICT', JSON.stringify(fk));
  const trg = schema.triggers.find((t) => t.name === 'trg_emp_bi');
  check(`${key} trigger`, trg?.timing === 'BEFORE' && trg?.event === 'INSERT' && /NEW\.name/.test(trg?.statement ?? ''), JSON.stringify(trg));

  const er = await req('GET', `/api/connections/${c.id}/${db}/er`, T);
  check(`${key} er parallel`, Array.isArray(er.schemas) === false && er.schemas['ms_emp'] !== undefined && Array.isArray(er.errors), `tables=${er.tables.length} errors=${JSON.stringify(er.errors)}`);
  const rel = er.relations.find((r) => r.constraint === 'fk_emp_dept');
  check(`${key} er relation`, rel?.table === 'ms_emp' && rel?.column === 'dept_id' && rel?.refTable === 'ms_dept' && rel?.refColumn === 'id' && rel?.onDelete === 'CASCADE', JSON.stringify(rel));

  // дамп: индексы и FK должны сохраниться
  const dump = await (await fetch(`${BASE}/api/connections/${c.id}/${db}/ms_emp/export?format=sql`, { headers: { authorization: `Bearer ${T}` } })).text();
  check(`${key} dump autoInc`, /AUTO_INCREMENT/.test(dump), dump.split('\n').slice(0, 3).join(' / '));
  check(`${key} dump unique index`, /CREATE UNIQUE INDEX/.test(dump) && /email/.test(dump), '');
  check(`${key} dump composite index`, new RegExp(`CREATE INDEX .?\\S+.? ON .?\\S+.? \\(.?dept_id.?, .?name.?\\)`).test(dump), (dump.match(/CREATE INDEX[^;]*/g) ?? []).join(' | '));
  check(`${key} dump fk`, /ADD CONSTRAINT .*FOREIGN KEY \(.?dept_id.?\) REFERENCES .?ms_dept.? \(.?id.?\)( ON DELETE CASCADE)?( ON UPDATE RESTRICT)?/.test(dump) && /ON DELETE CASCADE/.test(dump) && /ON UPDATE RESTRICT/.test(dump), (dump.match(/ALTER TABLE[^;]*/g) ?? []).join(' | '));
  check(`${key} dump no phantom default`, !/DEFAULT 'NULL'/.test(dump), '');

  await req('POST', `/api/connections/${c.id}/query`, T, { sql: 'DROP TABLE ms_emp' });
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: 'DROP TABLE ms_dept' });
}

// --- PostgreSQL: serial, составной PK-индекс, FK, триггер на функции
{
  const c = await syncHost(byName['e2e-pg']);
  const db = 'demo';
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: 'DROP TABLE IF EXISTS ms_child' });
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: 'DROP TABLE IF EXISTS ms_parent' });
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: 'CREATE TABLE ms_parent (id SERIAL PRIMARY KEY, code VARCHAR(10) NOT NULL, tenant INT NOT NULL, UNIQUE (code, tenant))' });
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: 'CREATE TABLE ms_child (id SERIAL PRIMARY KEY, parent_id INT REFERENCES ms_parent(id) ON DELETE SET NULL)' });
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: 'CREATE FUNCTION ms_touch() RETURNS trigger AS $$ BEGIN NEW.code := upper(NEW.code); RETURN NEW; END; $$ LANGUAGE plpgsql' });
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: 'CREATE TRIGGER trg_child_bi BEFORE INSERT ON ms_child FOR EACH ROW EXECUTE FUNCTION ms_touch()' });

  const parent = await req('GET', `/api/connections/${c.id}/${db}/ms_parent/schema`, T);
  checkModel('pg', parent);
  const id = parent.columns.find((col) => col.name === 'id');
  check('pg serial autoInc', id?.autoInc === true && /nextval/.test(String(id?.default)), JSON.stringify(id));
  const uniq = parent.indexes.find((ix) => ix.unique && ix.columns.length === 2);
  check('pg unique composite', uniq?.columns.join(',') === 'code,tenant', JSON.stringify(parent.indexes.map((ix) => `${ix.name}:${ix.columns.join('+')}`)));
  check('pg index definition', parent.indexes.some((ix) => typeof ix.definition === 'string' && ix.definition.includes('CREATE')), '');

  const child = await req('GET', `/api/connections/${c.id}/${db}/ms_child/schema`, T);
  const fk = child.foreignKeys[0];
  check('pg fk on delete', fk?.refTable === 'ms_parent' && fk?.onDelete === 'SET NULL' && fk?.onUpdate === 'NO ACTION', JSON.stringify(fk));
  const trg = child.triggers[0];
  check('pg trigger parsed', trg?.name === 'trg_child_bi' && trg?.timing === 'BEFORE' && trg?.event === 'INSERT', JSON.stringify(trg));

  const dump = await (await fetch(`${BASE}/api/connections/${c.id}/${db}/ms_child/export?format=sql`, { headers: { authorization: `Bearer ${T}` } })).text();
  check('pg dump serial', /SERIAL/.test(dump), dump.split('\n').slice(0, 3).join(' / '));
  check('pg dump fk', /FOREIGN KEY \(.?parent_id.?\) REFERENCES .?ms_parent.? \(.?id.?\)/.test(dump) && /ON DELETE SET NULL/.test(dump), (dump.match(/ALTER TABLE[^;]*/g) ?? []).join(' | '));

  await req('POST', `/api/connections/${c.id}/query`, T, { sql: 'DROP TABLE ms_child' });
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: 'DROP TABLE ms_parent' });
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: 'DROP FUNCTION ms_touch()' });
}

// --- SQLite: индексы, FK, триггер с телом BEGIN..END, view
{
  const c = byName['e2e-sqlite'];
  const db = 'main';
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: 'DROP TABLE IF EXISTS ms_child_rt' });
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: 'DROP VIEW IF EXISTS ms_view' });
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: 'DROP TABLE IF EXISTS ms_child' });
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: 'DROP TABLE IF EXISTS ms_parent' });
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: 'CREATE TABLE ms_parent (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL)' });
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: 'CREATE TABLE ms_child (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER REFERENCES ms_parent(id) ON DELETE CASCADE, name TEXT UNIQUE)' });
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: 'CREATE INDEX idx_child_name ON ms_child (name)' });
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: 'CREATE TRIGGER trg_child_ai AFTER INSERT ON ms_child BEGIN UPDATE ms_parent SET title = title WHERE id = NEW.parent_id; END' });
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: 'CREATE VIEW ms_view AS SELECT id, title FROM ms_parent' });

  const schema = await req('GET', `/api/connections/${c.id}/${db}/ms_child/schema`, T);
  checkModel('sqlite', schema);
  check('sqlite explicit index', schema.indexes.some((ix) => ix.name === 'idx_child_name' && ix.columns.join(',') === 'name'), JSON.stringify(schema.indexes.map((ix) => ix.name)));
  check('sqlite autoindex not primary flag', schema.indexes.filter((ix) => ix.name.startsWith('sqlite_autoindex')).every((ix) => ix.primary === false), '');
  const fk = schema.foreignKeys[0];
  check('sqlite fk', fk?.refTable === 'ms_parent' && fk?.onDelete === 'CASCADE', JSON.stringify(fk));
  const trg = schema.triggers[0];
  check('sqlite trigger body', trg?.name === 'trg_child_ai' && trg?.timing === 'AFTER' && trg?.event === 'INSERT' && /UPDATE ms_parent/.test(trg?.statement ?? ''), JSON.stringify(trg)?.slice(0, 200));

  const view = await req('GET', `/api/connections/${c.id}/${db}/ms_view/schema`, T);
  check('sqlite view kind', view.kind === 'view' && view.columns.length === 2, JSON.stringify(view.columns.map((col) => col.name)));

  // дамп SQLite: автоиндексы sqlite_* нельзя создать вручную — их пропускаем
  const dump = await (await fetch(`${BASE}/api/connections/${c.id}/${db}/ms_child/export?format=sql`, { headers: { authorization: `Bearer ${T}` } })).text();
  check('sqlite dump autoincrement', /INTEGER PRIMARY KEY AUTOINCREMENT/.test(dump), dump.split('\n').slice(0, 3).join(' / '));
  check('sqlite dump no sqlite_ index', !/CREATE .*INDEX .?sqlite_autoindex/.test(dump), (dump.match(/CREATE .*INDEX[^;]*/g) ?? []).join(' | '));
  check('sqlite dump fk inline', !/ADD CONSTRAINT/.test(dump) && /FOREIGN KEY \(.?parent_id.?\) REFERENCES .?ms_parent.? \(.?id.?\) ON DELETE CASCADE/.test(dump), (dump.match(/FOREIGN KEY[^)]*\)[^,;]*/g) ?? []).join(' | '));
  // round-trip: дамп должен применяться к чистой БД
  const roundTripSql = dump
    .replaceAll('ms_child', 'ms_child_rt')
    .replaceAll('ms_parent', 'ms_parent_rt')
    .replaceAll('idx_child_name', 'idx_child_name_rt')
    .replaceAll('CREATE VIEW', '-- CREATE VIEW');
  const roundTrip = await req('POST', `/api/connections/${c.id}/import`, T, { format: 'sql', db, data: roundTripSql });
  check('sqlite dump round-trip', roundTrip.statements > 0, JSON.stringify(roundTrip));
  const rt = await req('GET', `/api/connections/${c.id}/${db}/ms_child_rt/schema`, T);
  check('sqlite round-trip schema', rt.columns.length === 3 && rt.foreignKeys.length === 1 && rt.indexes.some((ix) => ix.name === 'idx_child_name_rt') && rt.foreignKeys[0].onDelete === 'CASCADE', JSON.stringify({ cols: rt.columns.length, fks: rt.foreignKeys.length, idx: rt.indexes.map((ix) => ix.name), onDelete: rt.foreignKeys[0]?.onDelete }));
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: 'DROP TABLE IF EXISTS ms_child_rt' });
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: 'DROP VIEW IF EXISTS ms_view' });
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: 'DROP TABLE ms_child' });
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: 'DROP TABLE ms_parent' });
}

// --- MongoDB/Redis: модель тоже валидна, но без DDL-сущностей
{
  const mongo = byName['e2e-mongo'];
  const ms = await req('GET', `/api/connections/${mongo.id}/demo/users/schema`, T);
  checkModel('mongo', ms);
  check('mongo no ddl entities', ms.indexes.length === 0 && ms.foreignKeys.length === 0 && ms.triggers.length === 0, '');
  const redis = await ensureRedis(req, T, byName);
  const rs = await req('GET', `/api/connections/${redis.id}/0/e2e_foo/schema`, T);
  checkModel('redis', rs);
}

// --- стабильность /er при битой таблице: одна ошибка не роняет ответ
{
  const c = await syncHost(byName['e2e-mysql']);
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: 'DROP TABLE IF EXISTS ms_view' });
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: 'CREATE VIEW ms_view AS SELECT 1 AS one' });
  const er = await req('GET', `/api/connections/${c.id}/demo/er`, T);
  check('er survives view', Array.isArray(er.tables) && er.schemas['ms_view'] !== undefined, JSON.stringify(er.errors));
  check('er totalTables', typeof er.totalTables === 'number' && er.totalTables >= er.tables.length, `${er.totalTables}/${er.tables.length}`);
  await req('POST', `/api/connections/${c.id}/query`, T, { sql: 'DROP VIEW ms_view' });
}

if (failures) { console.log(`FAILURES: ${failures}`); process.exit(1); }
console.log('MODEL ALL GREEN');
