import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../core/config.js';
import type { PanelUser } from '../core/auth.js';

const MAX_BYTES = 100 * 1024 * 1024;

function me(req: unknown): PanelUser | undefined {
  return (req as { user?: PanelUser }).user;
}

function dirFor(metaPath: string): string {
  const d = join(dirname(metaPath), 'sqlite');
  mkdirSync(d, { recursive: true });
  return d;
}

function safeName(name: string): string {
  const b = basename(name);
  if (!/^[A-Za-z0-9_.-]{1,64}\.(db|sqlite|sqlite3)$/.test(b)) throw Object.assign(new Error('Bad filename (alphanum 1-64 + .db/.sqlite)'), { statusCode: 400 });
  return b;
}

export function sqliteFileRoutes(app: FastifyInstance, cfg: AppConfig): void {
  app.get('/api/sqlite/files', async (req) => {
    const u = me(req);
    if (!u) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    const d = dirFor(cfg.metaPath);
    const files = readdirSync(d).filter((f) => /\.(db|sqlite|sqlite3)$/.test(f));
    return files.map((f) => {
      const st = statSync(join(d, f));
      return { name: f, bytes: st.size, mtime: st.mtimeMs };
    });
  });

  app.post('/api/sqlite/files', async (req) => {
    const u = me(req);
    if (!u || u.role === 'readonly') throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    // multipart зарегистрирован в app.ts (корневой scope) — req.parts() доступен здесь.
    // Идём по частям, а не через req.file(): лимит files в busboy обрывает поток
    // на середине запроса, и запрос зависает без ответа. Ограничение «ровно один
    // файл» enforcing ниже, лишние части дочитываются (draining).
    let saved: { name: string; bytes: number } | null = null;
    let tooMany = false;
    try {
      for await (const part of req.parts()) {
        if (part.type !== 'file') continue;
        if (saved) {
          tooMany = true;
          part.file.resume();
          continue;
        }
        const name = safeName(part.filename);
        const full = join(dirFor(cfg.metaPath), name);
        try {
          await pipeline(part.file, createWriteStream(full));
        } catch (e) {
          rmSync(full, { force: true });
          throw e;
        }
        // part.file.truncated — лимит размера из multipart сработал при чтении
        if (part.file.truncated) {
          rmSync(full, { force: true });
          throw Object.assign(new Error(`File too large (${MAX_BYTES / 1024 / 1024}MB)`), { statusCode: 413 });
        }
        const st = statSync(full);
        if (st.size > MAX_BYTES) { rmSync(full, { force: true }); throw Object.assign(new Error(`File too large (${MAX_BYTES / 1024 / 1024}MB)`), { statusCode: 413 }); }
        saved = { name, bytes: st.size };
      }
    } catch (e: any) {
      // не multipart-запрос / битое тело — понятная 4xx вместо 500;
      // ошибки без statusCode (ENOSPC и прочие внутренние) уходят как 500 и санитизируются
      const code = typeof e?.code === 'string' ? e.code : '';
      if (code.startsWith('FST_')) throw Object.assign(new Error(e.message ?? 'Bad multipart request'), { statusCode: e.statusCode ?? 400 });
      if (!e?.statusCode) throw e;
      throw Object.assign(new Error(e.message ?? 'Expected multipart/form-data with a file'), { statusCode: e.statusCode });
    }
    if (tooMany) throw Object.assign(new Error('Only one file can be uploaded at a time'), { statusCode: 400 });
    if (!saved) throw Object.assign(new Error('No file'), { statusCode: 400 });
    return saved;
  });

  app.get('/api/sqlite/files/:name/download', async (req, reply) => {
    const u = me(req);
    if (!u) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    const { name } = req.params as { name: string };
    const safe = safeName(name);
    const full = join(dirFor(cfg.metaPath), safe);
    if (!existsSync(full)) throw Object.assign(new Error('Not found'), { statusCode: 404 });
    reply.header('content-type', 'application/octet-stream').header('content-disposition', `attachment; filename="${safe}"`);
    return reply.send(createReadStream(full));
  });

  app.delete('/api/sqlite/files/:name', async (req) => {
    const u = me(req);
    if (!u || u.role !== 'admin') throw Object.assign(new Error('Admin only'), { statusCode: 403 });
    const { name } = req.params as { name: string };
    const safe = safeName(name);
    const full = join(dirFor(cfg.metaPath), safe);
    if (!existsSync(full)) throw Object.assign(new Error('Not found'), { statusCode: 404 });
    unlinkSync(full);
    return { ok: true };
  });
}
