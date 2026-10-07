// Проверка содержимого встроенной справки (DocsModal).
//
// Зачем: справка живёт отдельно от кода, и новая возможность появляется в
// интерфейсе раньше, чем её описывают. Так было с Oracle, переводом типов между
// СУБД, клонированием таблиц и листанием уведомлений: реализовано — но в справке
// не упомянуто. Список обязательных тем зафиксирован здесь, и DocsModal обязан их
// показывать, а словарь — содержать во всех шести языках.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { translations } from '../src/locales/index.js';

const DOCS = fileURLToPath(new URL('../src/components/modals/DocsModal.tsx', import.meta.url));
const docs = readFileSync(DOCS, 'utf8');

const results: boolean[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`);
};

const LANGS = ['ru', 'en', 'de', 'fr', 'es', 'zh'];

/** Обязательные темы справки и слова-маркеры русского текста. */
const TOPICS: { key: string; about: string[] }[] = [
  { key: 'tabModels', about: ['модел'] },
  { key: 'modelsP', about: ['схем'] },
  { key: 'modelsTypesP', about: ['DEFAULT'] },
  { key: 'modelsTypes1', about: ['VARCHAR2'] },
  { key: 'modelsTypes2', about: ['4000'] },
  { key: 'modelsTypes3', about: ['NUMBER'] },
  { key: 'modelsApply6', about: ['пропущено'] },
  { key: 'oracle1', about: ['Oracle'] },
  { key: 'tablesClone1', about: ['CREATE TABLE'] },
  { key: 'tablesClone2', about: ['списк'] },
  { key: 'tablesNames1', about: ['#__mywidget'] },
  // Уведомления: листание кнопками и стрелками — реализовано, но в справке
  // не было описано, поэтому тема тоже под контролем.
  { key: 'startBoxNotif', about: ['уведомл'] },
  { key: 'startNotif2', about: ['3 / 50', '←'] },
  // Redis: почему в списке баз не 16 строк, а только непустые.
  { key: 'redis7', about: ['SELECT', '0…15'] },
  // Экспорт всей базы: выбор области, порядок по внешним ключам и то, что
  // составной CSV делится по строкам «# table:».
  { key: 'transferExport6', about: ['внешним ключам', '# table:'] },
];

// 1. Ключ обязан быть в DocsModal — иначе тема есть в словаре, но не видна.
for (const { key } of TOPICS) {
  check(`DocsModal показывает docs.${key}`, docs.includes(`t('docs.${key}')`));
}

// 2. Ключ обязан существовать и быть непустым во всех шести языках. Порог длины
//    здесь 2, а не 10: китайские и японские надписи короче латинских вдвое,
//    и «项目模型» — полноценный перевод, а не заглушка.
for (const { key } of TOPICS) {
  const missing = LANGS.filter((l) => {
    const value = (translations as any)[l]?.docs?.[key];
    return typeof value !== 'string' || value.trim().length < 2;
  });
  check(`docs.${key} переведён во все языки`, missing.length === 0, missing.join(',') || '6/6');
}

// 3. Русский текст должен mention ожидаемое: тема формально есть, а по делу
//    ничего не объясняет — так и вышло с Oracle до правки.
for (const { key, about } of TOPICS) {
  const text = String((translations as any).ru?.docs?.[key] ?? '');
  const missing = about.filter((w) => !text.toLowerCase().includes(w.toLowerCase()));
  check(`docs.${key} говорит о «${about.join('», «')}»`, missing.length === 0, missing.length ? 'нет: ' + missing.join(',') : '');
}

// 4. Вкладка справки должна быть достижима: не только ключ, но и пункт меню.
const tabIds = [...docs.matchAll(/^ {6}id: '([a-z]+)',$/gm)].map((m) => m[1]);
check('вкладка models есть среди вкладок справки', tabIds.includes('models'), tabIds.join(','));
check('вкладок справки не меньше 12', tabIds.length >= 12, String(tabIds.length));

const failed = results.filter((x) => !x).length;
console.log(failed ? `FAILURES: ${failed}` : `DOCS CONTENT ALL GREEN (${results.length})`);
process.exit(failed ? 1 : 0);
