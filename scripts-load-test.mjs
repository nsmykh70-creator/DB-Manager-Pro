// Нагрузочный прогон панели: конкурентные клиенты по ключевым роутам.
// Без зависимостей, только Node. Держимся ниже RATE_LIMIT_MAX (паузы между
// итерациями), цель — латентность p50/p95/max и отсутствие 5xx, а не DDoS.
import fs from 'node:fs';
const BASE = process.env.LOAD_BASE ?? 'http://localhost:3001';
const WORKERS = Number(process.env.LOAD_WORKERS ?? 10);
const ITERS = Number(process.env.LOAD_ITERS ?? 60);
const THINK_MS = Number(process.env.LOAD_THINK_MS ?? 50);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const envLines = fs.readFileSync('backend/.env', 'utf8').split('\n');
const env = {};
for (const line of envLines) {
  if (!line.includes('=')) continue;
  const i = line.indexOf('=');
  env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
const T = (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: env.ADMIN_USER, password: env.ADMIN_PASSWORD }) }).then(r => r.json())).token;
const conns = await fetch(BASE + '/api/connections', { headers: { authorization: `Bearer ${T}` } }).then(r => r.json());
const mysql = conns.find(c => c.name === 'e2e-mysql');
const pg = conns.find(c => c.name === 'e2e-pg');

const scenarios = [
  { name: 'health', weight: 2, run: () => fetch(BASE + '/api/health').then(r => ({ s: r.status })) },
  { name: 'tables', weight: 3, run: () => fetch(`${BASE}/api/connections/${mysql.id}/demo/tables`, { headers: { authorization: `Bearer ${T}` } }).then(async r => ({ s: r.status })) },
  { name: 'rows', weight: 3, run: () => fetch(`${BASE}/api/connections/${mysql.id}/demo/users/rows?page=1&pageSize=50`, { headers: { authorization: `Bearer ${T}` } }).then(async r => ({ s: r.status })) },
  { name: 'schema', weight: 1, run: () => fetch(`${BASE}/api/connections/${pg.id}/demo/users/schema`, { headers: { authorization: `Bearer ${T}` } }).then(async r => ({ s: r.status })) },
  { name: 'query', weight: 1, run: () => fetch(`${BASE}/api/connections/${mysql.id}/query`, { method: 'POST', headers: { authorization: `Bearer ${T}`, 'content-type': 'application/json' }, body: JSON.stringify({ sql: 'SELECT * FROM users LIMIT 10', db: 'demo' }) }).then(async r => ({ s: r.status })) },
];
const bag = scenarios.flatMap(s => Array(s.weight).fill(s));
const stats = new Map();
const record = (name, ms, status) => {
  if (!stats.has(name)) stats.set(name, { n: 0, errors: {}, times: [] });
  const st = stats.get(name);
  st.n++;
  st.times.push(ms);
  if (status < 200 || status >= 300) st.errors[status] = (st.errors[status] ?? 0) + 1;
};
const pct = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))]; };

const t0 = Date.now();
await Promise.all(Array.from({ length: WORKERS }, async (_, w) => {
  for (let i = 0; i < ITERS; i++) {
    const sc = bag[(w + i) % bag.length];
    const t = Date.now();
    try {
      const r = await sc.run();
      record(sc.name, Date.now() - t, r.s);
    } catch {
      record(sc.name, Date.now() - t, 0);
    }
    await sleep(THINK_MS);
  }
}));
const totalSec = (Date.now() - t0) / 1000;
let total = 0, failed = 0;
for (const [name, st] of stats) {
  const err = Object.values(st.errors).reduce((a, b) => a + b, 0);
  total += st.n; failed += err;
  console.log(`${name}: n=${st.n} err=${JSON.stringify(st.errors)} p50=${pct(st.times, 50)}ms p95=${pct(st.times, 95)}ms max=${Math.max(...st.times)}ms`);
}
console.log(`TOTAL req=${total} failed=${failed} rps=${(total / totalSec).toFixed(1)} workers=${WORKERS} iters=${ITERS}`);
process.exit(failed ? 1 : 0);
