// Idempotent seed of the `demo` fixtures used by the e2e suites.
// Runs from the host, so it talks to the published Docker ports:
//   MySQL 127.0.0.1:3306, MariaDB 127.0.0.1:3307, PostgreSQL :5432, MongoDB :27017.
// Override with E2E_*_HOST / E2E_*_PORT when the stack runs elsewhere.
import mysql from 'mysql2/promise';
import { Client } from 'pg';
import { MongoClient } from 'mongodb';

const MYSQL_HOST = process.env.E2E_MYSQL_HOST || '127.0.0.1';
const MYSQL_PORT = Number(process.env.E2E_MYSQL_PORT || 3306);
const MARIADB_HOST = process.env.E2E_MARIADB_HOST || '127.0.0.1';
const MARIADB_PORT = Number(process.env.E2E_MARIADB_PORT || 3307);
const PG_HOST = process.env.E2E_PG_HOST || '127.0.0.1';
const PG_PORT = Number(process.env.E2E_PG_PORT || 5432);
const MONGO_HOST = process.env.E2E_MONGO_HOST || '127.0.0.1';
const MONGO_PORT = Number(process.env.E2E_MONGO_PORT || 27017);

async function seedMySQL(port, tag, host) {
  const boot = await mysql.createConnection({ host, port, user: 'root', password: 'root', multipleStatements: true });
  await boot.query(`CREATE DATABASE IF NOT EXISTS demo`);
  await boot.end();
  const c = await mysql.createConnection({ host, port, user: 'root', password: 'root', database: 'demo' });
  await c.query(`DROP TABLE IF EXISTS users`);
  await c.query(`CREATE TABLE users (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100), age INT)`);
  await c.query(`INSERT INTO users (name, age) VALUES ('Ann', 30), ('Bob', 25)`);
  await c.end();
  console.log(tag, 'seed ok');
}

async function seedPg() {
  const boot = new Client({ host: PG_HOST, port: PG_PORT, user: 'root', password: 'root', database: 'postgres' });
  await boot.connect();
  await boot.query(`CREATE DATABASE demo`).catch(() => {});
  await boot.end().catch(() => {});
  const c = new Client({ host: PG_HOST, port: PG_PORT, user: 'root', password: 'root', database: 'demo' });
  await c.connect();
  await c.query(`DROP TABLE IF EXISTS users`);
  await c.query(`CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT, age INT)`);
  await c.query(`INSERT INTO users (name, age) VALUES ('Ann', 30), ('Bob', 25)`);
  await c.end();
  console.log('pg seed ok');
}

async function seedMongo() {
  const c = new MongoClient(`mongodb://${MONGO_HOST}:${MONGO_PORT}`);
  await c.connect();
  const col = c.db('demo').collection('users');
  await col.deleteMany({});
  await col.insertMany([{ name: 'Ann', age: 30 }, { name: 'Bob', age: 25 }]);
  await c.close();
  console.log('mongo seed ok');
}

for (let i = 0; i < 10; i++) {
  try {
    await seedMySQL(MYSQL_PORT, 'mysql', MYSQL_HOST);
    await seedMySQL(MARIADB_PORT, 'maria', MARIADB_HOST);
    await seedPg();
    await seedMongo();
    break;
  } catch (e) {
    console.log('retry:', String(e?.message ?? e).slice(0, 120));
    await new Promise((r) => setTimeout(r, 8000));
    if (i === 9) throw e;
  }
}
