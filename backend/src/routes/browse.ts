import type { FastifyInstance } from 'fastify';
import { getDriver } from '../plugins/registry.js';
import type { AppConfig } from '../core/config.js';
import { loadDecrypted } from '../core/context.js';
import { existsSync } from 'node:fs';
import type { GlobalSearchHit, GlobalSearchResult, Relation, TableSchema } from '../core/types.js';

/** Потолок таблиц в одном ER-ответе: схема каждой тянется отдельными запросами. */
const ER_TABLE_LIMIT = 100;

function positiveInt(value: unknown, fallback: number, max: number): number {
  const n = Number(value ?? fallback);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : fallback;
}

function containsSearchValue(value: unknown, query: string): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'object') {
    try { return JSON.stringify(value).toLowerCase().includes(query); } catch { return false; }
  }
  return String(value).toLowerCase().includes(query);
}

function containsSearchValueInRow(row: Record<string, unknown>, query: string): boolean {
  return Object.values(row).some(value => containsSearchValue(value, query));
}

export function browseRoutes(app: FastifyInstance, cfg: AppConfig): void {
  const need = (kind: string) => {
    const d = getDriver(kind as Parameters<typeof getDriver>[0]);
    if (!d) throw Object.assign(new Error(`No driver for ${kind}`), { statusCode: 400 });
    return d;
  };

  app.get('/api/connections/:id/databases', async (req) => {
    const { id } = req.params as { id: string };
    const cc = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, id);
    try {
      return await need(cc.kind).listDatabases(cc);
    } catch (e: any) {
      if (cc.kind === 'sqlite' && !cc.filePath) return ['main'];
      throw Object.assign(e, { statusCode: e?.statusCode ?? 502 });
    }
  });

  app.get('/api/connections/:id/:db/tables', async (req) => {
    const { id, db } = req.params as { id: string; db: string };
    const cc = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, id);
    try {
      return await need(cc.kind).listTables(cc, decodeURIComponent(db));
    } catch (e: any) {
      if (cc.kind === 'sqlite' && cc.filePath && !existsSync(cc.filePath)) return [];
      throw Object.assign(e, { statusCode: e?.statusCode ?? 502 });
    }
  });

  app.get('/api/connections/:id/:db/:table/schema', async (req) => {
    const { id, db, table } = req.params as { id: string; db: string; table: string };
    const cc = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, id);
    return need(cc.kind).getSchema(cc, decodeURIComponent(db), decodeURIComponent(table));
  });

  app.get('/api/connections/:id/:db/:table/rows', async (req) => {
    const { id, db, table } = req.params as { id: string; db: string; table: string };
    const { page, pageSize, sort, filter } = (req.query ?? {}) as Record<string, string>;
    const cc = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, id);
    return need(cc.kind).getPage(cc, decodeURIComponent(db), decodeURIComponent(table), Number(page ?? 1), Number(pageSize ?? 50), sort, filter);
  });

  app.get('/api/connections/:id/:db/search', async (req) => {
    const { id, db } = req.params as { id: string; db: string };
    const { q, page: pageValue, pageSize: pageSizeValue, limit: limitValue } = (req.query ?? {}) as Record<string, string>;
    const query = String(q ?? '').trim().toLowerCase();
    if (!query || query.length > 200) throw Object.assign(new Error('Search query must contain 1..200 characters'), { statusCode: 400 });
    const page = positiveInt(pageValue, 1, 10000);
    const pageSize = positiveInt(pageSizeValue, 50, 100);
    const limit = positiveInt(limitValue, 1000, 5000);
    const cc = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, id);
    const d = need(cc.kind);
    const dbname = decodeURIComponent(db);
    const tableNames = await d.listTables(cc, dbname);
    const hits: GlobalSearchHit[] = [];
    const tableCounts = new Map<string, number>();
    const errors: { table: string; error: string }[] = [];
    let truncated = false;

    for (const table of tableNames) {
      let tablePage = 1;
      try {
        for (;;) {
          const data = await d.getPage(cc, dbname, table, tablePage, 500);
          for (const row of data.rows) {
            if (!containsSearchValueInRow(row, query)) continue;
            tableCounts.set(table, (tableCounts.get(table) ?? 0) + 1);
            hits.push({ table, columns: data.columns, row });
            if (hits.length > limit) {
              truncated = true;
              break;
            }
          }
          if (truncated || !data.truncated) break;
          tablePage++;
        }
      } catch (e) {
        errors.push({ table, error: String((e as Error).message ?? e).slice(0, 200) });
      }
      if (truncated) break;
    }

    const result: GlobalSearchResult = {
      hits: hits.slice((page - 1) * pageSize, page * pageSize),
      tables: [...tableCounts.entries()].map(([table, matches]) => ({ table, matches })),
      errors,
      page,
      pageSize,
      total: Math.min(hits.length, limit),
      truncated,
    };
    return result;
  });

  app.get('/api/connections/:id/:db/er', async (req) => {
    const { id, db } = req.params as { id: string; db: string };
    const cc = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, id);
    const d = need(cc.kind);
    const dbname = decodeURIComponent(db);
    const names = await d.listTables(cc, dbname);
    const limited = names.slice(0, ER_TABLE_LIMIT);
    // Схемы тянем параллельно: 100 последовательных getSchema на большой базе —
    // это десятки секунд. Одна упавшая таблица (нет прав, битая) не должна
    // ронять весь ответ — она попадает в errors и просто выпадает из графа.
    const settled = await Promise.allSettled(limited.map((t) => d.getSchema(cc, dbname, t)));
    const schemas: Record<string, TableSchema> = {};
    const errors: { table: string; error: string }[] = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') schemas[limited[i]] = r.value;
      else errors.push({ table: limited[i], error: String(r.reason?.message ?? r.reason).slice(0, 200) });
    });
    let relations: Relation[] = [];
    if (d.getRelations) {
      try {
        relations = await d.getRelations(cc, dbname);
      } catch (e: any) {
        errors.push({ table: '*', error: String(e?.message ?? e).slice(0, 200) });
      }
    }
    return {
      tables: limited,
      schemas,
      relations,
      truncated: names.length > limited.length,
      totalTables: names.length,
      errors
    };
  });

  app.get('/api/connections/:id/status', async (req) => {
    const { id } = req.params as { id: string };
    const cc = loadDecrypted(cfg.metaPath, cfg.encryptionKeyHex, id);
    const d = getDriver(cc.kind);
    if (!d?.getStatus) return { version: `${cc.kind} (status unsupported)`, processlist: [], dbSizes: [], extra: {} };
    try {
      return await d.getStatus(cc);
    } catch (e: any) {
      throw Object.assign(e, { statusCode: e?.statusCode ?? 502 });
    }
  });
}
