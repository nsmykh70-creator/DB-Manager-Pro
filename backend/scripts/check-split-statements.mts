import { splitStatements } from '../src/drivers/helpers.js';

const cases: [string, number][] = [
  ['SELECT 1; SELECT 2;', 2],
  ["SELECT 'a;b'; SELECT 2", 2],
  ['-- c; comment\nSELECT 1;', 1],
  ['/* a; b */ SELECT 1;', 1],
  ['CREATE TRIGGER t AFTER INSERT ON x BEGIN UPDATE y SET a=1; END;', 1],
  ['CREATE TRIGGER t AFTER INSERT ON x BEGIN UPDATE y SET a=1; END; SELECT 1;', 2],
  ["CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN NEW.a := 1; RETURN NEW; END; $$ LANGUAGE plpgsql; SELECT 1;", 2],
  ['CREATE TABLE a (x INT); CREATE INDEX i ON a(x);', 2],
  ['BEGIN TRANSACTION; SELECT 1; COMMIT;', 3],
  ["SELECT 'it''s; fine'; SELECT 2", 2],
  ['SELECT CASE WHEN 1=1 THEN 2 ELSE 3 END; SELECT 2;', 2],
  ['CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT CASE WHEN 1=1 THEN 2 END; UPDATE y SET a=1; END; SELECT 9;', 2]
];

let failures = 0;
for (const [sql, want] of cases) {
  const got = splitStatements(sql);
  const ok = got.length === want;
  if (!ok) failures++;
  console.log((ok ? 'PASS' : 'FAIL') + ` | want=${want} got=${got.length} | ${sql.slice(0, 60).replace(/\n/g, ' ')}`);
  if (!ok) got.forEach((s, i) => console.log(`   [${i}] ${s.slice(0, 90)}`));
}
if (failures) { console.log(`FAILURES: ${failures}`); process.exit(1); }
console.log('SPLIT OK');
