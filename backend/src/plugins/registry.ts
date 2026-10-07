import type { DbDriver, DbKind } from '../core/types.js';

// Реестр драйверов — точка расширения. Добавить БД = создать драйвер + register().
const registry = new Map<DbKind, DbDriver>();

export function register(driver: DbDriver): void {
  registry.set(driver.kind, driver);
}

export function getDriver(kind: DbKind): DbDriver | undefined {
  return registry.get(kind);
}

export function kinds(): DbKind[] {
  return [...registry.keys()];
}
