import { mapColumnType, mapDefault } from '../../backend/src/core/typemap.js';
for (const t of ['INT(11)', 'BIGINT(20)', 'TINYINT(1)', 'TINYINT(3)', 'SMALLINT(6)', 'MEDIUMINT(9)', 'INT', 'VARCHAR(255)', 'DECIMAL(10,2)', 'TEXT']) {
  console.log(t.padEnd(14), '-> oracle:', mapColumnType(t, 'oracle').padEnd(16), '| pg:', mapColumnType(t, 'pg').padEnd(16), '| mysql:', mapColumnType(t, 'mysql').padEnd(16), '| sqlite:', mapColumnType(t, 'sqlite'));
}
for (const d of ["''", '0', 'CURRENT_TIMESTAMP']) {
  console.log('default', JSON.stringify(d).padEnd(20), '-> oracle:', JSON.stringify(mapDefault(d, 'oracle')), '| pg:', JSON.stringify(mapDefault(d, 'pg')));
}
