import type { DbKind } from './api';

/**
 * Типы СУБД, которыми управляют тумблеры в настройках.
 *
 * Список живёт здесь, потому что его используют и настройки, и боковые
 * панели: раньше каждый файл держал свою копию, и «postgres» в одном месте
 * расходилось с «postgresql» в другом.
 *
 * Пустой enabledKinds или его отсутствие означают «все включены»: настройка
 * появилась позже настроек, которые уже записаны у пользователей, и трактовка
 * «пусто = ничего не показывать» молча спрятала бы все подключения.
 */
export const ALL_KINDS: readonly DbKind[] = [
  'mysql', 'mariadb', 'postgres', 'sqlite', 'mongodb', 'redis', 'oracle'
];

/** Названия типов для интерфейса — это имена продуктов, переводить их нельзя. */
export const KIND_LABELS: Record<string, string> = {
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  postgres: 'PostgreSQL',
  postgresql: 'PostgreSQL',
  sqlite: 'SQLite',
  mongodb: 'MongoDB',
  redis: 'Redis',
  oracle: 'Oracle'
};

/** Боковые панели группируют по postgresql, API отдаёт postgres. */
export function normalizeKind(kind: string): DbKind {
  return (kind === 'postgresql' ? 'postgres' : kind) as DbKind;
}

export function isKindEnabled(kind: string, enabledKinds?: readonly string[] | null): boolean {
  if (!enabledKinds || enabledKinds.length === 0) return true;
  return enabledKinds.includes(normalizeKind(kind));
}

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}