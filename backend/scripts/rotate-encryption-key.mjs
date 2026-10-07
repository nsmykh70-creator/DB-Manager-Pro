import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { decrypt, encrypt } from '../dist/core/crypto.js';

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readEnv(file) {
  const result = {};
  if (!existsSync(file)) return result;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 1) continue;
    result[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return result;
}

const envFile = resolve(process.cwd(), '.env');
const env = readEnv(envFile);
const oldKey = arg('old-key') || env.ENCRYPTION_KEY;
const newKey = arg('new-key');
const metaPath = resolve(arg('meta') || env.META_PATH || './data/meta.db');
const dryRun = process.argv.includes('--dry-run');

if (!oldKey || !/^[a-f0-9]{64}$/i.test(oldKey)) throw new Error('--old-key or ENCRYPTION_KEY must be 64 hex characters');
if (!newKey || !/^[a-f0-9]{64}$/i.test(newKey)) throw new Error('--new-key must be 64 hex characters');
if (oldKey.toLowerCase() === newKey.toLowerCase()) throw new Error('Old and new keys are identical');
if (!existsSync(metaPath)) throw new Error(`Metadata database not found: ${metaPath}`);

const backupPath = `${metaPath}.before-encryption-rotation`;
const db = new Database(metaPath);
const rows = db.prepare('SELECT id, passwordCipher FROM connections WHERE passwordCipher IS NOT NULL').all();
const migrated = [];
const undecryptable = [];

for (const row of rows) {
  try {
    const plain = decrypt(row.passwordCipher, oldKey);
    migrated.push({ id: row.id, passwordCipher: dryRun ? row.passwordCipher : encrypt(plain, newKey) });
  } catch {
    undecryptable.push(row.id);
  }
}

if (dryRun) {
  console.log(JSON.stringify({ metaPath, total: rows.length, migratable: migrated.length, undecryptable }, null, 2));
  db.close();
  process.exit(undecryptable.length ? 2 : 0);
}

if (undecryptable.length) {
  console.error(JSON.stringify({ error: 'Some connections cannot be decrypted with the old key', undecryptable }, null, 2));
  db.close();
  process.exit(2);
}

copyFileSync(metaPath, backupPath);
const update = db.prepare('UPDATE connections SET passwordCipher=? WHERE id=?');
const transaction = db.transaction(() => {
  for (const row of migrated) update.run(row.passwordCipher, row.id);
});
transaction();
db.close();
console.log(JSON.stringify({ metaPath, backupPath, migrated: migrated.length, fingerprint: createHash('sha256').update(newKey).digest('hex').slice(0, 12) }, null, 2));
