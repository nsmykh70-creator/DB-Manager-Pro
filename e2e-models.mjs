import { ensureDatabase } from './e2e-fixtures.mjs';
// e2e-models.mjs — сохранённые модели проекта: CRUD, версии, импорт схемы, применение
const BASE = process.env.E2E_BASE ?? 'http://localhost:3001';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? process.env.E2E_ADMIN_PASSWORD ?? 'admin123';

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' | ' + extra : ''));
  if (!cond) failures++;
};
const req = async (method, path, token, body) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text.slice(0, 200) }; }
  return { status: r.status, body: parsed };
};

const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: ADMIN_PASSWORD })).body;
const T = admin.token;
const editor = (await req('POST', '/api/auth/login', null, { username: 'e2e_editor', password: 'editorpass123' })).body;
const ro = (await req('POST', '/api/auth/login', null, { username: 'ro_user', password: 'readonly123' })).body;
check('logins', !!T && !!editor.token && !!ro.token);

const conns = (await req('GET', '/api/connections', T)).body;
const mysql = conns.find((c) => c.name === 'e2e-mysql');
const pg = conns.find((c) => c.name === 'e2e-pg');

// --- импорт схемы существующей базы в модель
// Схему импортируем из demo: если базу удалили из UI, восстанавливаем.
// Общий помощень ждёт req, возвращающий тело ответа, а локальный возвращает
// {status, body} — отдаём ему адаптер.
const body = async (method, path, token, payload) => (await req(method, path, token, payload)).body;
await ensureDatabase(body, T, mysql.id);

const MODEL = 'e2e_model_shop';
await req('DELETE', `/api/models?name=${MODEL}`, T); // no-op, удаление по имени не поддерживается — см. ниже
const list0 = (await req('GET', '/api/models?limit=500', T)).body;
for (const m of list0.filter((x) => x.name === MODEL)) await req('DELETE', `/api/models/${m.id}`, T);

const imp = await req('POST', '/api/models/import', T, { connId: mysql.id, db: 'demo', name: MODEL, comment: 'shop schema' });
check('import schema into model', imp.status === 200 && imp.body.version === 1 && imp.body.tables.length >= 1,
  `status=${imp.status} tables=${imp.body?.tables?.length} ${JSON.stringify(imp.body).slice(0, 120)}`);
const model = imp.body;
check('model keeps columns', model.tables.every((t) => Array.isArray(t.columns) && t.columns.length > 0),
  JSON.stringify(model.tables.map((t) => `${t.name}:${t.columns.length}`)).slice(0, 140));
check('model dbKind recorded', model.dbKind === 'mysql' && model.dbName === 'demo', `${model.dbKind}/${model.dbName}`);

// --- права
check('readonly cannot import', (await req('POST', '/api/models/import', ro.token, { connId: mysql.id, db: 'demo', name: 'x' })).status === 403);
check('readonly cannot create', (await req('POST', '/api/models', ro.token, { name: 'x', tables: model.tables })).status === 403);
check('anonymous list blocked', (await req('GET', '/api/models')).status === 401);
check('editor can read', (await req('GET', '/api/models', editor.token)).status === 200);

// --- валидация
const bad1 = await req('POST', '/api/models', T, { name: 'bad name!', tables: model.tables });
check('bad model name rejected', bad1.status === 400, `status=${bad1.status}`);
const bad2 = await req('POST', '/api/models', T, { name: 'e2e_bad_tbl', tables: [{ name: 'ok', columns: [{ name: 'c', type: 'TEXT' }], indexes: [{ name: 'i', columns: ['nope'] }] }] });
check('index on unknown column rejected', bad2.status === 400, `status=${bad2.status}`);
const bad3 = await req('POST', '/api/models', T, { name: 'e2e_no_tables', tables: [] });
check('empty model rejected', bad3.status === 400, `status=${bad3.status}`);
const dup = await req('POST', '/api/models', T, { name: MODEL, tables: model.tables });
check('duplicate name rejected', dup.status === 409, `status=${dup.status}`);

// --- версии
const edited = model.tables.map((t) => ({ ...t }));
edited[0] = { ...edited[0], comment: 'v2' };
const v2 = await req('PUT', `/api/models/${model.id}`, T, { tables: edited, note: 'comment v2' });
check('save new version', v2.status === 200 && v2.body.version === 2, `status=${v2.status} v=${v2.body?.version}`);
const versions = (await req('GET', `/api/models/${model.id}/versions`, T)).body;
check('version history', versions.length === 1 && versions[0].version === 1, JSON.stringify(versions).slice(0, 120));
const stale = await req('PUT', `/api/models/${model.id}`, T, { tables: edited, expectedVersion: 1 });
check('stale version rejected', stale.status === 409, `status=${stale.status}`);
const v3 = await req('PUT', `/api/models/${model.id}`, T, { tables: edited, expectedVersion: 2 });
check('expectedVersion honoured', v3.status === 200 && v3.body.version === 3, `status=${v3.status} v=${v3.body?.version}`);

// --- откат на версию
const v1id = versions[0].id;
const restored = await req('POST', `/api/models/${model.id}/versions/${v1id}/restore`, T);
check('restore version', restored.status === 200 && restored.body.version === 4, `status=${restored.status} v=${restored.body?.version}`);
const afterRestore = await req('GET', `/api/models/${model.id}`, T);
check('restored content without comment v2', afterRestore.body.tables[0].comment !== 'v2', JSON.stringify(afterRestore.body.tables[0].comment));
check('history kept after restore', (await req('GET', `/api/models/${model.id}/versions`, T)).body.length === 3,
  'n=' + (await req('GET', `/api/models/${model.id}/versions`, T)).body.length);

// --- переименование и поиск
const renamed = await req('PATCH', `/api/models/${model.id}`, T, { name: MODEL + '_2', comment: 'renamed' });
check('rename model', renamed.status === 200 && renamed.body.name === MODEL + '_2', `status=${renamed.status}`);
const found = (await req('GET', `/api/models?q=${MODEL}`, T)).body;
check('search by name', found.some((m) => m.id === model.id), 'n=' + found.length);
const byKind = (await req('GET', '/api/models?dbKind=postgres', T)).body;
check('filter by dbKind', byKind.every((m) => m.dbKind === 'postgres'), 'n=' + byKind.length);

// --- применение к другой базе: mysql → pg
const TARGET = 'e2e_model_target';
await req('POST', `/api/connections/${pg.id}/query`, T, { sql: `DROP DATABASE IF EXISTS ${TARGET}` });
const create = await req('POST', '/api/databases', T, { connectionId: pg.id, name: TARGET });
check('target database created', create.status === 200, `status=${create.status} ${JSON.stringify(create.body).slice(0, 80)}`);

// модель из двух простых таблиц, без MySQL-специфики
const simple = {
  name: 'e2e_model_simple',
  dbKind: 'mysql',
  tables: [
    {
      name: 'mdl_parent',
      columns: [
        { name: 'id', type: 'INT', primary: true, autoInc: true, nullable: false },
        { name: 'title', type: 'VARCHAR(100)', nullable: false }
      ],
      indexes: [{ name: 'idx_mdl_parent_title', columns: ['title'], unique: false }]
    },
    {
      name: 'mdl_child',
      columns: [
        { name: 'id', type: 'INT', primary: true, autoInc: true, nullable: false },
        { name: 'parent_id', type: 'INT', nullable: false },
        { name: 'note', type: 'TEXT' }
      ],
      indexes: [],
      foreignKeys: [{ name: 'fk_mdl_child_parent', columns: ['parent_id'], refTable: 'mdl_parent', refColumns: ['id'], onDelete: 'CASCADE' }]
    }
  ]
};
const simpleCreated = await req('POST', '/api/models', T, simple);
check('create simple model', simpleCreated.status === 200, `status=${simpleCreated.status} ${JSON.stringify(simpleCreated.body).slice(0, 100)}`);

const applied = await req('POST', `/api/models/${simpleCreated.body.id}/apply`, T, { connId: pg.id, db: TARGET });
check('apply model to another database', applied.status === 200 && applied.body.ok === true,
  `status=${applied.status} ${JSON.stringify(applied.body).slice(0, 200)}`);
check('both tables created', (applied.body.created ?? []).length === 2, JSON.stringify(applied.body.created));
const pgTables = (await req('GET', `/api/connections/${pg.id}/${TARGET}/tables`, T)).body;
check('tables really exist in pg', pgTables.includes('mdl_parent') && pgTables.includes('mdl_child'), JSON.stringify(pgTables));
const parentSchema = (await req('GET', `/api/connections/${pg.id}/${TARGET}/mdl_parent/schema`, T)).body;
const childSchema = (await req('GET', `/api/connections/${pg.id}/${TARGET}/mdl_child/schema`, T)).body;
check('index applied to its own table', parentSchema.indexes.some((i) => i.name === 'idx_mdl_parent_title'),
  JSON.stringify(parentSchema.indexes.map((i) => i.name)));
check('foreign key applied', childSchema.foreignKeys.length === 1 && childSchema.foreignKeys[0].refTable === 'mdl_parent',
  JSON.stringify(childSchema.foreignKeys).slice(0, 140));
check('columns applied', childSchema.columns.length === 3, JSON.stringify(childSchema.columns.map((c) => c.name)));

// повторное применение не трогает существующие таблицы
const again = await req('POST', `/api/models/${simpleCreated.body.id}/apply`, T, { connId: pg.id, db: TARGET });
check('re-apply skips existing', again.status === 200 && (again.body.skipped ?? []).length === 2, JSON.stringify(again.body.skipped));

// с dropExisting — пересоздание + чекпоинт
await req('POST', `/api/connections/${pg.id}/${TARGET}/mdl_parent/rows`, T, { row: { title: 'keep me' } }).catch(() => {});
const replaced = await req('POST', `/api/models/${simpleCreated.body.id}/apply`, T, { connId: pg.id, db: TARGET, dropExisting: true });
check('apply with dropExisting', replaced.status === 200 && (replaced.body.replaced ?? []).length === 2, JSON.stringify(replaced.body.replaced));
const parentRows = (await req('GET', `/api/connections/${pg.id}/${TARGET}/mdl_parent/rows?page=1&pageSize=10`, T)).body;
check('data dropped by replace', (parentRows.rows ?? []).length === 0, 'rows=' + (parentRows.rows ?? []).length);
check('checkpoint taken before replace', (replaced.body.statements ?? []).some((s) => s.startsWith('-- checkpoint')),
  JSON.stringify((replaced.body.statements ?? []).slice(0, 2)));

// --- сравнение модели с базой (drift)
{
  const DB = 'e2e_diff_db';
  const clean = async (sql) => req('POST', `/api/connections/${pg.id}/query`, T, { sql, db: DB }).catch(() => {});
  // Первичная уборка идёт БЕЗ db: на этом шаге базы может ещё не существовать,
  // и DROP с указанием несуществующей базы молча ничего не делал — прошлый
  // прогон оставлял таблицы, и «пустая база» оказывалась непустой.
  await req('POST', `/api/connections/${pg.id}/query`, T, { sql: `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)` }).catch(() => {});
  await req('POST', '/api/databases', T, { connectionId: pg.id, name: DB });

  const m = (await req('POST', '/api/models', T, {
    name: 'e2e_diff_' + Date.now(),
    tables: [
      {
        name: 'df_p',
        columns: [
          { name: 'id', type: 'INT', primary: true, autoInc: true, nullable: false },
          { name: 'title', type: 'VARCHAR(100)', nullable: false }
        ],
        indexes: [{ name: 'ix_df_p_title', columns: ['title'] }]
      },
      { name: 'df_absent', columns: [{ name: 'id', type: 'INT', primary: true, nullable: false }] }
    ]
  })).body;

  // 1) пустая база: всё отсутствует
  let d = (await req('POST', `/api/models/${m.id}/diff`, T, { connId: pg.id, db: DB })).body;
  check('diff: empty db missing all', d.missingTables.length === 2 && d.extraTables.length === 0, JSON.stringify(d.summary));
  check('diff: empty db not equal', d.equal === false);

  // 2) применили модель → расхождений нет (в т.ч. автоиндекс PK не считаем лишним,
  //    а INT/VARCHAR(100) приравнены к integer/character varying(100))
  const ap = (await req('POST', `/api/models/${m.id}/apply`, T, { connId: pg.id, db: DB })).body;
  check('diff: apply created tables', (ap.created ?? []).length === 2, JSON.stringify(ap.created));
  d = (await req('POST', `/api/models/${m.id}/diff`, T, { connId: pg.id, db: DB })).body;
  check('diff: equal right after apply', d.equal === true, JSON.stringify(d.summary) + ' ' + JSON.stringify(d.changedTables.map((x) => x.table)));
  check('diff: implicit pk index ignored', d.changedTables.every((x) => x.extraIndexes.length === 0), JSON.stringify(d.changedTables.flatMap((x) => x.extraIndexes)));

  // 3) ручные правки в базе: лишний столбец, индекс, таблица
  await clean('ALTER TABLE df_p ADD COLUMN note TEXT');
  await clean('CREATE INDEX ix_df_p_note ON df_p (note)');
  await clean('CREATE TABLE df_manual (id INT PRIMARY KEY)');
  d = (await req('POST', `/api/models/${m.id}/diff`, T, { connId: pg.id, db: DB })).body;
  check('diff: extra table', d.extraTables.includes('df_manual'), JSON.stringify(d.extraTables));
  const p = d.changedTables.find((x) => x.table === 'df_p');
  check('diff: extra column', p?.extraColumns.includes('note'), JSON.stringify(p?.extraColumns));
  check('diff: extra index', p?.extraIndexes.includes('ix_df_p_note'), JSON.stringify(p?.extraIndexes));
  const noExtra = (await req('POST', `/api/models/${m.id}/diff`, T, { connId: pg.id, db: DB, includeExtra: false })).body;
  check('diff: includeExtra=false hides extras', noExtra.extraTables.length === 0 && noExtra.changedTables.every((x) => x.extraColumns.length === 0), JSON.stringify(noExtra.extraTables));

  // 4) изменение типа и удаление таблицы
  await clean('ALTER TABLE df_p ALTER COLUMN title TYPE TEXT');
  d = (await req('POST', `/api/models/${m.id}/diff`, T, { connId: pg.id, db: DB })).body;
  const p2 = d.changedTables.find((x) => x.table === 'df_p');
  check('diff: type change detected', (p2?.changedColumns ?? []).some((c) => c.column === 'title' && c.changes.some((x) => x.startsWith('тип'))), JSON.stringify(p2?.changedColumns));
  await clean('DROP TABLE df_absent');
  d = (await req('POST', `/api/models/${m.id}/diff`, T, { connId: pg.id, db: DB })).body;
  check('diff: dropped table is missing', d.missingTables.includes('df_absent'), JSON.stringify(d.missingTables));

  // 5) ошибки и права
  check('diff needs connId+db', (await req('POST', `/api/models/${m.id}/diff`, T, { connId: pg.id })).status === 400);
  check('diff unknown model 404', (await req('POST', '/api/models/nope/diff', T, { connId: pg.id, db: DB })).status === 404);
  // Чтение схемы роль readonly делать может (как и GET /schema), поэтому diff
  // ему доступен; запрещено то, что меняет базу — apply (проверяется ниже).
  check('readonly can read diff', (await req('POST', `/api/models/${m.id}/diff`, ro.token, { connId: pg.id, db: DB })).status === 200);

  await req('DELETE', `/api/models/${m.id}`, T);
  await clean(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
}

// readonly/editor на apply
check('readonly cannot apply', (await req('POST', `/api/models/${simpleCreated.body.id}/apply`, ro.token, { connId: pg.id, db: TARGET })).status === 403);

// --- удаление
check('editor cannot delete model', (await req('DELETE', `/api/models/${simpleCreated.body.id}`, editor.token)).status === 403);
check('admin deletes model', (await req('DELETE', `/api/models/${simpleCreated.body.id}`, T)).status === 200);
check('deleted model 404', (await req('GET', `/api/models/${simpleCreated.body.id}`, T)).status === 404);
check('unknown version 404', (await req('GET', `/api/models/${model.id}/versions/nope`, T)).status === 404);
for (const m of (await req('GET', '/api/models?limit=500', T)).body.filter((x) => x.name.startsWith('e2e_model'))) {
  await req('DELETE', `/api/models/${m.id}`, T);
}

// уборка
await req('POST', `/api/connections/${pg.id}/query`, T, { sql: `DROP DATABASE IF EXISTS ${TARGET} WITH (FORCE)` });
const listAfter = (await req('GET', '/api/models?limit=500', T)).body;
check('no leftover models', !listAfter.some((m) => m.name.startsWith('e2e_model')), JSON.stringify(listAfter.map((m) => m.name)).slice(0, 120));

if (failures) { console.log(`FAILURES: ${failures}`); process.exit(1); }
console.log('MODELS ALL GREEN');
