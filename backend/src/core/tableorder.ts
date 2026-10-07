/**
 * Порядок таблиц для дампа: родители раньше детей.
 *
 * Без сортировки дамп восстанавливается не всегда — таблицы выдаются в
 * алфавитном порядке, и запрос с внешним ключом может прийти раньше таблицы,
 * на которую ссылается. Сортируем топологически по графу «кто на кого ссылается».
 * Цикл терпим: FK таблицы на саму себя (встречается в наследуемых схемах)
 * рвать порядок не должен.
 */
export async function dependencyOrder(
  tables: string[],
  refsOf: (table: string) => Promise<string[]>
): Promise<string[]> {
  const present = new Set(tables);
  const deps = new Map<string, Set<string>>();
  for (const t of tables) {
    let refs: string[] = [];
    try { refs = await refsOf(t); } catch { refs = []; }
    deps.set(t, new Set(refs.filter((r) => present.has(r) && r !== t)));
  }

  const out: string[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();

  const visit = (t: string): void => {
    if (done.has(t) || visiting.has(t)) return;
    visiting.add(t);
    for (const dep of deps.get(t) ?? []) visit(dep);
    visiting.delete(t);
    done.add(t);
    out.push(t);
  };

  for (const t of tables) visit(t);
  return out;
}