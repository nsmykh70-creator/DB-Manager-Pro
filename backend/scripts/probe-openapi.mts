// Проверка спецификации OpenAPI без стенда: строим приложение и смотрим, что
// реально попало в спецификацию. Нужна была, чтобы отличить «маршруты скрыты
// фильтром» от «плагин их вообще не видел» — выглядит одинаково (0 paths).
import { buildApp } from '../src/app.js';

const app = await buildApp();
await app.ready();

const spec = app.swagger();
const paths = Object.keys(spec?.paths ?? {});
console.log('маршрутов в спецификации:', paths.length);
console.log('всего в приложении:', app.printRoutes().split('\n').length);
console.log('первые:', paths.slice(0, 8).join(', '));

// У каждого маршрута должен быть хотя бы метод: иначе запись в paths получена
// от схемы, а не от реального эндпоинта.
const empty = paths.filter((p) => Object.keys(spec.paths[p] ?? {}).length === 0);
console.log('пустых записей в paths:', empty.length);

await app.close();
process.exit(paths.length > 0 ? 0 : 1);