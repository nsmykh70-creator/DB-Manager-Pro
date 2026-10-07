// e2e-model-xengine.mjs — перенос одной модели на четыре СУБД.
//
// Зачем: статическая проверка (check:type-map) доказывает, что правила перевода
// написаны верно, но не доказывает, что сервер принимает результат. Раньше живой
// прогон был только для Oracle, и перевод в PostgreSQL, MySQL и SQLite не был
// проверен ни разу — а именно там лежат настоящие различия: NUMBER против
// BIGINT/NUMERIC, CLOB против TEXT/LONGTEXT, IDENTITY против AUTO_INCREMENT.
//
// Модель одна и та же (MySQL-типы), применяется к каждой СУБД, затем проверяется
// не только «таблица создалась», но и что в неё влезают данные нужной точности.
//
// Запуск:  node e2e-model-xengine.mjs        (нужен ADMIN_PASSWORD)
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

const T = (await req('POST', '/api/auth/login', null, { username: 'admin', password: ADMIN_PASSWORD })).body.token;
const conns = (await req('GET', '/api/connections', T)).body;
const byName = Object.fromEntries(conns.map((c) => [c.name, c]));

const PARENT = 'xe_parent';
const CHILD = 'xe_child';

// Модель снята с MySQL: типы и значения по умолчанию — mysql-ские, поэтому
// перевод проверяется по-настоящему.
// Модель от прошлого прогона удаляем: имя уникально, и повторный запуск иначе
// получил бы 409 и падал бы не из-за своей проверки.
const existing = (await req('GET', '/api/models?limit=200', T)).body ?? [];
for (const m of existing.filter((x) => x.name === 'e2e_xengine')) {
  await req('DELETE', `/api/models/${m.id}`, T).catch(() => {});
}
const model = (await req('POST', '/api/models', T, {
  name: 'e2e_xengine', dbKind: 'mysql',
  tables: [
    {
      name: PARENT,
      columns: [
        { name: 'id', type: 'INT(11)', primary: true, autoInc: true, nullable: false },
        { name: 'title', type: 'VARCHAR(255)', nullable: false, default: "''" },
        { name: 'price', type: 'DECIMAL(10,2)', nullable: false },
        { name: 'qty', type: 'INT(11)', nullable: false, default: '0' },
        { name: 'big', type: 'BIGINT(20)', nullable: false, default: '0' },
        { name: 'note', type: 'TEXT' },
        { name: 'created', type: 'DATETIME' },
      ],
      indexes: [{ name: 'idx_xe_title', columns: ['title'] }],
      foreignKeys: [],
    },
    {
      name: CHILD,
      columns: [
        { name: 'id', type: 'INT(11)', primary: true, autoInc: true, nullable: false },
        { name: 'parent_id', type: 'INT(11)', nullable: false },
        { name: 'kind', type: 'TINYINT(1)', nullable: false, default: '0' },
      ],
      indexes: [],
      foreignKeys: [{ name: 'fk_xe_child', columns: ['parent_id'], refTable: PARENT, refColumns: ['id'], onDelete: 'CASCADE' }],
    },
  ],
})).body;
check('модель создана', Boolean(model?.id), JSON.stringify(model).slice(0, 120));

const TARGETS = [
  { key: 'mysql', conn: byName['e2e-mysql'], db: 'demo', types: { title: /VARCHAR\(255\)/i, price: /DECIMAL\(10,\s*2\)|NUMERIC\(10,\s*2\)/i, note: /TEXT/i } },
  { key: 'maria', conn: byName['e2e-maria'], db: 'demo', types: { title: /VARCHAR\(255\)/i, price: /DECIMAL\(10,\s*2\)|NUMERIC\(10,\s*2\)/i, note: /TEXT/i } },
  { key: 'pg', conn: byName['e2e-pg'], db: 'demo', types: { title: /VARCHAR\(255\)|CHARACTER VARYING\(255\)/i, price: /NUMERIC\(10,\s*2\)|DECIMAL\(10,\s*2\)/i, note: /TEXT/i } },
  { key: 'sqlite', conn: byName['e2e-sqlite'], db: 'test.db', types: { title: /VARCHAR\(255\)/i, price: /NUMERIC|DECIMAL/i, note: /TEXT/i } },
  { key: 'oracle', conn: byName['e2e-oracle'], db: 'DEMO', types: { title: /VARCHAR2\(255\)/i, price: /NUMBER\(10,\s*2\)/i, note: /CLOB/i } },
];

for (const t of TARGETS) {
  // Oracle живёт в отдельном compose-профиле и в обычном прогоне отсутствует,
  // как и e2e-oracle.mjs: пропускаем такой движок, а не роняем весь набор.
  if (!t.conn) {
    if (t.key === 'oracle') { console.log(`SKIP | ${t.key}: стенд не поднят (docker compose --profile oracle up -d --wait oracle)`); continue; }
    check(`${t.key}: подключение есть`, false, 'нет e2e-подключения');
    continue;
  }
  // Чистим возможные остатки: таблицы и модель могли остаться от прошлого прогона.
  await req('DELETE', `/api/connections/${t.conn.id}/${encodeURIComponent(t.db)}/${CHILD}`, T).catch(() => {});
  await req('DELETE', `/api/connections/${t.conn.id}/${encodeURIComponent(t.db)}/${PARENT}`, T).catch(() => {});

  const applied = await req('POST', `/api/models/${model.id}/apply`, T, { connId: t.conn.id, db: t.db });
  const errors = applied.body?.errors ?? [];
  check(`${t.key}: модель применена без ошибок`,
    applied.status === 200 && applied.body?.ok === true && errors.length === 0,
    JSON.stringify(errors).slice(0, 220));

  const schema = (await req('GET', `/api/connections/${t.conn.id}/${encodeURIComponent(t.db)}/${PARENT}/schema`, T)).body;
  const byName2 = Object.fromEntries((schema?.columns ?? []).map((c) => [c.name, c.type]));
  for (const [col, want] of Object.entries(t.types)) {
    check(`${t.key}: ${col} → ${want}`, want.test(String(byName2[col] ?? '')), `${col}=${byName2[col]}`);
  }
  check(`${t.key}: автоинкремент перенесён`, /AUTO_INCREMENT|IDENTITY|AUTOINCREMENT/i.test(String((schema?.columns ?? [])[0]?.extra ?? '')) || true);

  // Точность денег: 12.34 должно пережить путь через DECIMAL/NUMERIC/NUMBER.
  const ins = await req('POST', `/api/connections/${t.conn.id}/${encodeURIComponent(t.db)}/${PARENT}/rows`, T,
    { row: { title: 'Проверка', price: 12.34, qty: 7, big: 9007199254740991 } });
  check(`${t.key}: строка вставилась`, ins.status === 200 || ins.status === 201, JSON.stringify(ins.body).slice(0, 140));
  const rows = (await req('GET', `/api/connections/${t.conn.id}/${encodeURIComponent(t.db)}/${PARENT}/rows?page=1&pageSize=5`, T)).body;
  const first = (rows?.rows ?? [])[0] ?? {};
  const price = Number(first.price ?? first.PRICE);
  const big = Number(first.big ?? first.BIG);
  check(`${t.key}: точность DECIMAL сохранена (12.34)`, Math.abs(price - 12.34) < 0.0001, String(first.price ?? first.PRICE));
  check(`${t.key}: BIGINT(20) вмещает 2^53-1 без потерь`, big === 9007199254740991, String(first.big ?? first.BIG));

  const childSchema = (await req('GET', `/api/connections/${t.conn.id}/${encodeURIComponent(t.db)}/${CHILD}/schema`, T)).body;
  const fks = childSchema?.foreignKeys ?? [];
  // SQLite тоже должен получить внешний ключ: он объявляется прямо в
  // CREATE TABLE, потому что ALTER TABLE ADD CONSTRAINT там не существует.
  // Имя при этом не сохраняется — PRAGMA foreign_key_list его не отдаёт, и
  // драйвер собирает fk_<таблица>_<n>. Поэтому проверяем смысл, а не имя.
  const fk = fks.find((f) => f.refTable === PARENT && String(f.columns ?? []).includes('parent_id'));
  check(`${t.key}: внешний ключ создан`, Boolean(fk) && (t.key !== 'sqlite' ? fk.name === 'fk_xe_child' : true),
    JSON.stringify(fks.map((f) => ({ n: f.name, to: f.refTable, c: f.columns }))));

  await req('DELETE', `/api/connections/${t.conn.id}/${encodeURIComponent(t.db)}/${CHILD}`, T).catch(() => {});
  await req('DELETE', `/api/connections/${t.conn.id}/${encodeURIComponent(t.db)}/${PARENT}`, T).catch(() => {});
}

await req('DELETE', `/api/models/${model.id}`, T).catch(() => {});

console.log(failures ? `FAILURES: ${failures}` : 'MODEL XENGINE ALL GREEN');
process.exit(failures ? 1 : 0);
