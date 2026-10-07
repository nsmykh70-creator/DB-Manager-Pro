// e2e-row-lock.mjs — оптимистичная блокировка правок: конфликт больше не затирает
// чужое изменение, а сообщает о нём (409 + актуальная строка).
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
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text.slice(0, 120) }; }
  return { status: r.status, body: parsed };
};

const T = (await req('POST', '/api/auth/login', null, { username: 'admin', password: ADMIN_PASSWORD })).body.token;
const ro = (await req('POST', '/api/auth/login', null, { username: 'ro_user', password: 'readonly123' })).body.token;
const conns = (await req('GET', '/api/connections', T)).body;
const byName = Object.fromEntries(conns.map((c) => [c.name, c]));
const TBL = 'lock_cc';

for (const [name, db] of [['e2e-mysql', 'demo'], ['e2e-maria', 'demo'], ['e2e-pg', 'demo'], ['e2e-sqlite', 'main'], ['e2e-mongo', 'demo']]) {
  const c = byName[name];
  if (!c) { check(`${name} connection`, false); continue; }
  const col = c.kind === 'mongodb' ? 'v' : 'note';
  await req('DELETE', `/api/connections/${c.id}/${db}/${TBL}`, T).catch(() => {});
  const def = c.kind === 'mongodb'
    ? { name: TBL, columns: [{ name: 'v', type: 'TEXT' }] }
    : c.kind === 'sqlite'
      ? { name: TBL, columns: [{ name: 'id', type: 'INTEGER', primary: true, nullable: false }, { name: 'note', type: 'TEXT' }] }
      : { name: TBL, columns: [{ name: 'id', type: 'INT', primary: true, autoInc: true, nullable: false }, { name: 'note', type: 'TEXT' }] };
  await req('POST', `/api/connections/${c.id}/${db}/tables`, T, def);
  // Поле проверки должно существовать в строке: иначе expected={поле: undefined}
  // превратится в {} и блокировка не включится (для SQL null тоже не проверяем).
  const row = c.kind === 'sqlite' ? { id: 1, note: 'orig' } : { [col]: 'orig' };
  await req('POST', `/api/connections/${c.id}/${db}/${TBL}/rows`, T, { row });
  const loaded = ((await req('GET', `/api/connections/${c.id}/${db}/${TBL}/rows?page=1&pageSize=10`, T)).body.rows ?? [])[0] ?? {};
  const pkKeys = Object.keys(loaded).filter((k) => k === 'id' || k === '_id');
  const filter = Object.fromEntries(pkKeys.map((k) => [k, loaded[k]]));
  const read = async () => ((await req('GET', `/api/connections/${c.id}/${db}/${TBL}/rows?page=1&pageSize=10`, T)).body.rows ?? []);
  const url = `/api/connections/${c.id}/${db}/${TBL}/rows`;

  // правка с актуальным expected проходит
  const ok = await req('PATCH', url, T, { filter, patch: { [col]: 'first' }, expected: { [col]: loaded[col] } });
  check(`${name} update with fresh expected`, ok.status === 200 && ok.body.matched === 1, `status=${ok.status}`);

  // конкурентная правка того же поля → наша устаревшая правка отклоняется
  await req('PATCH', url, T, { filter, patch: { [col]: 'second' } });
  const conflict = await req('PATCH', url, T, { filter, patch: { [col]: 'mine' }, expected: { [col]: loaded[col] } });
  check(`${name} stale update is 409`, conflict.status === 409, `status=${conflict.status} ${String(conflict.body.error).slice(0, 70)}`);
  check(`${name} 409 returns current row`, conflict.body.current?.[col] === 'second', JSON.stringify(conflict.body.current ?? null).slice(0, 90));
  check(`${name} 409 lists checked columns`, Array.isArray(conflict.body.checked) && conflict.body.checked.includes(col), JSON.stringify(conflict.body.checked));
  check(`${name} foreign change not overwritten`, (await read())[0]?.[col] === 'second', `value=${(await read())[0]?.[col]}`);

  // без expected поведение прежнее (обратная совместимость)
  const noExpected = await req('PATCH', url, T, { filter, patch: { [col]: 'third' } });
  check(`${name} update without expected works`, noExpected.status === 200 && noExpected.body.matched === 1, `status=${noExpected.status}`);

  // удаление с устаревшим expected отклоняется, строка остаётся
  const staleDelete = await req('DELETE', url, T, { filter, expected: { [col]: loaded[col] } });
  check(`${name} stale delete is 409`, staleDelete.status === 409, `status=${staleDelete.status}`);
  check(`${name} row survived stale delete`, (await read()).length === 1, 'rows=' + (await read()).length);
  const goodDelete = await req('DELETE', url, T, { filter, expected: { [col]: 'third' } });
  check(`${name} fresh delete works`, goodDelete.status === 200 && goodDelete.body.deleted === 1, `status=${goodDelete.status}`);
  check(`${name} row deleted`, (await read()).length === 0, 'rows=' + (await read()).length);

  // NULL-колонка в SQL не может участвовать в проверке (WHERE col = NULL не
  // находит строку) — убеждаемся, что это не ломает операцию
  if (c.kind !== 'mongodb') {
    await req('POST', url, T, { row: c.kind === 'sqlite' ? { id: 2, note: null } : { note: null } });
    const nullRow = (await read()).find((r) => r[col] === null) ?? (await read())[0];
    const nullFilter = Object.fromEntries(pkKeys.map((k) => [k, nullRow[k]]));
    const nullPatch = await req('PATCH', url, T, { filter: nullFilter, patch: { [col]: 'filled' }, expected: { [col]: null } });
    check(`${name} null column is not a conflict check`, nullPatch.status === 200, `status=${nullPatch.status}`);
    await req('DELETE', url, T, { filter: nullFilter });
  }

  // readonly по-прежнему не может писать
  check(`${name} readonly cannot update`, (await req('PATCH', url, ro, { filter, patch: { [col]: 'x' } })).status === 403);
  await req('DELETE', `/api/connections/${c.id}/${db}/${TBL}`, T).catch(() => {});
}

if (failures) { console.log(`FAILURES: ${failures}`); process.exit(1); }
console.log('ROW LOCK ALL GREEN');
