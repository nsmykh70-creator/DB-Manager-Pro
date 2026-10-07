/**
 * Порядок категорий СУБД в боковой панели: MySQL, MariaDB, PostgreSQL, SQLite,
 * MongoDB, Redis, Oracle — в том порядке, в который их поставил пользователь.
 *
 * По умолчанию порядок задаёт SUPPORTED_KINDS, и он же является фильтром
 * выключенных в настройках типов. Сохранённый порядок накладывается поверх, и
 * поэтому тип, добавленный позже (Oracle), без явного перемещения оказывается в
 * конце — как и должен: пользователь его ещё не двигал.
 *
 * Хранится отдельным доменом `kindorder`, а не вместе с порядком баз: один
 * версионированный ключ на оба списка означал бы, что смена формата одного
 * ломает чтение другого.
 */
import { createOrderStore } from './orderStore';

export { moveKey, moveKeyBy, sortRows, normalizeOrder } from './orderStore';

export const KIND_ORDER_VERSION = 1;

/** Группа-хранение одна: список типов не вложен в категории. */
export const KIND_GROUP = '_kinds';

export const kindOrderStore = createOrderStore({ domain: 'kindorder', defaultGroup: KIND_GROUP });