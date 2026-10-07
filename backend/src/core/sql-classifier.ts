const MUTATING_SQL_TOKENS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'UPSERT', 'REPLACE',
  'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME',
  'GRANT', 'REVOKE', 'DENY', 'COMMENT', 'SECURITY',
  'CALL', 'EXEC', 'EXECUTE', 'DO', 'COPY', 'LOAD', 'IMPORT',
  'SET', 'RESET', 'USE', 'VACUUM', 'ANALYZE', 'REINDEX', 'CLUSTER',
  'REFRESH', 'LOCK', 'UNLOCK', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE',
  'BEGIN', 'START', 'INTO'
]);

function sqlTokens(sql: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      i += 2;
      while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i++;
      continue;
    }
    if (c === '#') {
      i++;
      while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      const executable = sql[i + 2] === '!' || (sql[i + 2] === 'M' && sql[i + 3] === '!');
      let body = '';
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          body += '/*';
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          if (executable) body += sql[i];
          i++;
        }
      }
      if (executable) tokens.push(...sqlTokens(body));
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++;
      while (i < sql.length) {
        if (sql[i] === '\\' && i + 1 < sql.length) {
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '$') {
      const rest = sql.slice(i);
      const delimiter = rest.match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (delimiter) {
        const end = sql.indexOf(delimiter[0], i + delimiter[0].length);
        i = end < 0 ? sql.length : end + delimiter[0].length;
        continue;
      }
    }
    if (/[A-Za-z_]/.test(c)) {
      const start = i++;
      while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i])) i++;
      tokens.push(sql.slice(start, i).toUpperCase());
      continue;
    }
    i++;
  }
  return tokens;
}

export function isWriteSql(sql: string): boolean {
  return sqlTokens(sql).some((token) => MUTATING_SQL_TOKENS.has(token));
}
