import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { openMeta, closeMeta } from './store.js';
import { audit } from './context.js';

/**
 * Снапшоты самой meta.db (подключения, пользователи, расписания, история).
 * Потеря meta.db = потеря всего состояния панели, а пользовательские бэкапы
 * покрывают только данные СУБД — поэтому мета тоже копируется.
 */

export interface MetaBackup { file: string; bytes: number; at: number; }

export function metaBackupDir(metaPath: string): string {
  const dir = join(dirname(metaPath), 'meta-backups');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function safeName(file: string): string {
  const base = basename(String(file));
  if (!/^meta-.*\.db$/.test(base)) throw Object.assign(new Error('Bad snapshot name'), { statusCode: 400 });
  return base;
}

/** Онлайн-снапшот живого meta.db через VACUUM INTO (консистентен, WAL-safe). */
export function createMetaBackup(metaPath: string, actor?: string | null, keepLast = 7): MetaBackup {
  const dir = metaBackupDir(metaPath);
  audit(metaPath, null, 'meta.backup', null, true, 0, actor);
  // VACUUM INTO не принимает bind-параметры: имя уже проверено форматом ниже
  // через экранирование кавычек, путь — внутри нашего каталога.
  const file = `meta-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
  const full = join(dir, file);
  const esc = full.replace(/'/g, "''");
  openMeta(metaPath).exec(`VACUUM INTO '${esc}'`);
  const bytes = statSync(full).size;
  const keep = Math.min(50, Math.max(1, Math.floor(keepLast) || 7));
  const olds = readdirSync(dir)
    .filter((f) => /^meta-.*\.db$/.test(f))
    .map((f) => ({ f, at: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const o of olds.slice(keep)) rmSync(join(dir, o.f), { force: true });
  return { file, bytes, at: Date.now() };
}

export function listMetaBackups(metaPath: string): MetaBackup[] {
  const dir = metaBackupDir(metaPath);
  return readdirSync(dir)
    .filter((f) => /^meta-.*\.db$/.test(f))
    .map((f) => {
      const st = statSync(join(dir, f));
      return { file: f, bytes: st.size, at: Math.round(st.mtimeMs) };
    })
    .sort((a, b) => b.at - a.at);
}

/**
 * Восстановление: подменяем файл meta.db снапшотом и переоткрываем хендл.
 * Токены переживают замену (секреты в ENV), соединения перечитываются из файла.
 * После reopen пишем аудит уже в восстановленную базу.
 */
export function restoreMetaBackup(metaPath: string, file: string, actor?: string | null): { ok: true; file: string } {
  const base = safeName(file);
  const src = join(metaBackupDir(metaPath), base);
  if (!existsSync(src)) throw Object.assign(new Error('Snapshot not found'), { statusCode: 404 });
  closeMeta();
  try {
    copyFileSync(src, metaPath);
    rmSync(metaPath + '-wal', { force: true });
    rmSync(metaPath + '-shm', { force: true });
  } finally {
    openMeta(metaPath);
  }
  audit(metaPath, null, 'meta.restore', base, true, 0, actor);
  return { ok: true, file: base };
}
