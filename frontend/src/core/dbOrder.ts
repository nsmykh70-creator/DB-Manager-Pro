/**
 * Порядок баз данных внутри категории СУБД в боковой панели.
 *
 * Механика (перестановка, нормализация, работа с localStorage) — в общем
 * `orderStore.ts`; здесь только ключ строки и домен. Разметку и обработчики
 * держит Sidebar.tsx.
 *
 * Ключ строки составной: одна и та же база встречается у нескольких
 * подключений одного типа, и без id подключения перестановка была бы
 * неоднозначной.
 */
import { createOrderStore, type Order } from './orderStore';

export { moveKey, moveKeyBy, sortRows, normalizeOrder } from './orderStore';
export type { Order } from './orderStore';

export const DB_ORDER_VERSION = 1;

export type DbOrder = Order;

/** Ключ элемента списка: база может встречаться у нескольких подключений. */
export function dbRowKey(connId: string, db: string): string {
  return `${connId}:${db}`;
}

export const dbOrderStore = createOrderStore({ domain: 'dborder' });