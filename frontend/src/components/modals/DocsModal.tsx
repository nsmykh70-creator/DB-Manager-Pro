import React, { useState } from 'react';
import { useLanguage } from '../../contexts/LanguageContext';
import {
  X, Book, Rocket, Server, FolderPlus, Table, Code, ArrowRightLeft,
  Shield, HardDriveDownload, Activity, Layers, LifeBuoy, FileJson, Boxes
} from 'lucide-react';

interface DocsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

function Box({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-50 dark:bg-gray-800 p-4 rounded-lg">
      <h4 className="font-medium mb-2">{title}</h4>
      {children}
    </div>
  );
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="list-disc pl-5 space-y-1 text-sm text-gray-600 dark:text-gray-300">
      {items.map(item => <li key={item}>{item}</li>)}
    </ul>
  );
}

function Steps({ items }: { items: string[] }) {
  return (
    <ol className="list-decimal pl-5 space-y-1 text-sm text-gray-600 dark:text-gray-300">
      {items.map(item => <li key={item}>{item}</li>)}
    </ol>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="mt-2 text-xs font-mono bg-gray-100 dark:bg-gray-900/60 border border-gray-200 dark:border-gray-800 rounded p-2 overflow-x-auto text-gray-800 dark:text-gray-200">
      {children}
    </pre>
  );
}

export function DocsModal({ isOpen, onClose }: DocsModalProps) {
  const { t } = useLanguage();
  const [activeTab, setActiveTab] = useState('start');

  if (!isOpen) return null;

  const docs = [
    {
      id: 'start',
      title: t('docs.tabStart'),
      icon: <Rocket className="w-5 h-5 text-blue-500" />,
      content: (
        <div className="space-y-4">
          <h3 className="text-xl font-semibold">{t('docs.tabStart')}</h3>
          <p className="text-gray-600 dark:text-gray-300">{t('docs.startP')}</p>

          <Box title={t('docs.startBoxSteps')}>
            <Steps items={[
              t('docs.startStep1'),
              t('docs.startStep2'),
              t('docs.startStep3'),
              t('docs.startStep4'),
              t('docs.startStep5')
            ]} />
          </Box>

          <Box title={t('docs.startBoxNav')}>
            <Bullets items={[
              t('docs.startNav1'),
              t('docs.startNav2'),
              t('docs.startNav3'),
              t('docs.startNav4'),
              t('docs.startNav5')
            ]} />
          </Box>

          <Box title={t('docs.startBoxAuth')}>
            <Bullets items={[
              t('docs.startAuth1'),
              t('docs.startAuth2'),
              t('docs.startAuth3'),
              t('docs.startAuth4')
            ]} />
          </Box>

          <Box title={t('docs.startBoxNotif')}>
            <Bullets items={[
              t('docs.startNotif1'),
              t('docs.startNotif2'),
              t('docs.startNotif3'),
              t('docs.startNotif4')
            ]} />
          </Box>
        </div>
      )
    },
    {
      id: 'connections',
      title: t('docs.tabConnections'),
      icon: <Server className="w-5 h-5 text-blue-600" />,
      content: (
        <div className="space-y-4">
          <h3 className="text-xl font-semibold">{t('ui.connections')}</h3>
          <p className="text-gray-600 dark:text-gray-300">{t('docs.connP')}</p>

          <Box title={t('docs.connBoxFields')}>
            <Bullets items={[
              t('docs.connField1'),
              t('docs.connField2'),
              t('docs.connField3'),
              t('docs.connField4'),
              t('docs.connField5'),
              t('docs.connField6')
            ]} />
          </Box>

          <Box title={t('docs.connBoxSpecial')}>
            <Bullets items={[
              t('docs.connSpecial1'),
              'SQLite: путь только с прямыми слэшами. Обратные слэши (C:\\data\\app.db) на Linux и в Docker отклоняются с ошибкой — иначе создался бы файл-мусор, а запросы к нему падали бы с «no such table». На Windows-сервере путь приводится к виду C:/data/app.db.',
              t('docs.connSpecial3'),
              t('docs.connSpecialOracle'),
              t('docs.connSpecial4')
            ]} />
          </Box>

          <Box title={t('docs.connBoxReadonly')}>
            <Bullets items={[
              t('docs.connReadonly1'),
              t('docs.connReadonly2'),
              t('docs.connReadonly3')
            ]} />
          </Box>

          <Box title={t('docs.connBoxEdit')}>
            <Bullets items={[
              t('docs.connEdit1'),
              t('docs.connEdit2'),
              t('docs.connEdit3'),
              t('docs.connEdit4'),
              t('docs.connEdit5'),
              t('docs.connEdit6')
            ]} />
          </Box>
        </div>
      )
    },
    {
      id: 'createdb',
      title: t('docs.tabCreateDb'),
      icon: <FolderPlus className="w-5 h-5 text-emerald-500" />,
      content: (
        <div className="space-y-4">
          <h3 className="text-xl font-semibold">{t('docs.dbH3')}</h3>
          <p className="text-gray-600 dark:text-gray-300">{t('docs.dbP')}</p>

          <Box title={t('docs.dbBoxCreate')}>
            <Steps items={[
              t('docs.dbCreateStep1'),
              t('docs.dbCreateStep2'),
              t('docs.dbCreateStep3'),
              t('docs.dbCreateStep4')
            ]} />
            <Bullets items={[
              t('docs.dbCreateNote1'),
              t('docs.dbCreateNote2'),
              t('docs.dbCreateNote3'),
              t('docs.dbCreateNote4')
            ]} />
          </Box>

          <Box title={t('docs.dbBoxDrop')}>
            <Bullets items={[
              t('docs.dbDrop1'),
              t('docs.dbDrop2'),
              t('docs.dbDrop3')
            ]} />
          </Box>

          <Box title={t('docs.dbBoxSystem')}>
            <CodeBlock>{`MySQL / MariaDB   information_schema, mysql, performance_schema, sys
PostgreSQL        postgres, template0, template1
MongoDB           admin, local, config`}</CodeBlock>
          </Box>
        </div>
      )
    },
    {
      id: 'tables',
      title: t('docs.tabTables'),
      icon: <Table className="w-5 h-5 text-indigo-500" />,
      content: (
        <div className="space-y-4">
          <h3 className="text-xl font-semibold">{t('docs.tablesH3')}</h3>
          <p className="text-gray-600 dark:text-gray-300">{t('docs.tablesP')}</p>

          <Box title={t('docs.tablesBoxList')}>
            <Bullets items={[
              t('docs.tablesList1'),
              t('docs.tablesList2'),
              t('docs.tablesList3'),
              t('docs.tablesList4')
            ]} />
          </Box>

          <Box title={t('docs.tablesBoxCard')}>
            <Bullets items={[
              t('docs.tablesCard1'),
              t('docs.tablesCard2'),
              t('docs.tablesCard3'),
              t('docs.tablesCard4'),
              t('docs.tablesCard5'),
              t('docs.tablesCard6'),
              t('docs.tablesCard7')
            ]} />
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">{t('docs.tablesCardNote')}</p>
          </Box>

          <Box title={t('docs.tablesBoxTrigger')}>
            <Bullets items={[
              t('docs.tablesTrigger1'),
              t('docs.tablesTrigger2'),
              t('docs.tablesTrigger3'),
              t('docs.tablesTrigger4')
            ]} />
          </Box>

          <Box title={t('docs.tablesBoxNames')}>
            <Bullets items={[
              t('docs.tablesNames1'),
              t('docs.tablesNames2'),
              t('docs.tablesNames3')
            ]} />
          </Box>

          <Box title={t('docs.tablesBoxClone')}>
            <Bullets items={[
              t('docs.tablesClone1'),
              t('docs.tablesClone2'),
              t('docs.tablesClone3')
            ]} />
          </Box>

          <Box title={t('docs.tablesBoxDdl')}>
            <p className="text-sm text-gray-600 dark:text-gray-300">{t('docs.tablesDdlP')}</p>
            <Bullets items={[
              t('docs.tablesDdl1'),
              t('docs.tablesDdl2'),
              t('docs.tablesDdl3'),
              t('docs.tablesDdl4'),
              t('docs.tablesDdl5'),
              t('docs.tablesDdl6'),
              t('docs.tablesDdl7')
            ]} />
          </Box>

          <Box title={t('docs.tablesBoxRows')}>
            <Bullets items={[
              t('docs.tablesRows1'),
              t('docs.tablesRows2'),
              t('docs.tablesRows3'),
              t('docs.tablesRows4'),
              t('docs.tablesRows5'),
              t('docs.tablesRows6')
            ]} />
          </Box>

          <Box title={t('docs.tablesBoxButtons')}>
            <Bullets items={[
              t('docs.tablesButtons1'),
              t('docs.tablesButtons2'),
              t('docs.tablesButtons3'),
              t('docs.tablesButtons4'),
              t('docs.tablesButtons5')
            ]} />
          </Box>

          <Box title={t('docs.tablesBoxUndo')}>
            <Bullets items={[
              t('docs.undo1'),
              t('docs.undo2'),
              t('docs.undo3'),
              t('docs.undo4'),
              t('docs.undo5'),
              t('docs.undo6')
            ]} />
          </Box>

          <Box title={t('docs.tablesBoxConflict')}>
            <Bullets items={[
              t('docs.conflict1'),
              t('docs.conflict2'),
              t('docs.conflict3'),
              t('docs.conflict4')
            ]} />
          </Box>

          <Box title={t('docs.tablesBoxCompare')}>
            <Bullets items={[
              t('docs.compare1'),
              t('docs.compare2'),
              t('docs.compare3')
            ]} />
          </Box>
          <Box title={t('ui.projectModels')}>
            <Bullets items={[
              t('docs.models1'),
              t('docs.models2'),
              t('docs.models3'),
              t('docs.models4'),
              t('docs.models5'),
              t('docs.models6'),
              'Не путайте с точкой восстановления (дамп одной таблицы) и с «Откатить DDL» (откат одного пакета изменений).'
            ]} />
          </Box>

          <Box title={t('docs.tablesBoxCheckpoints')}>
            <Bullets items={[
              t('docs.checkpoints1'),
              t('docs.checkpoints2'),
              t('docs.checkpoints3'),
              t('docs.checkpoints4'),
              t('docs.checkpoints5'),
              t('docs.checkpoints6')
            ]} />
          </Box>
        </div>
      )
    },
    {
      id: 'bulk',
      title: t('docs.tabBulk'),
      icon: <Layers className="w-5 h-5 text-amber-500" />,
      content: (
        <div className="space-y-4">
          <h3 className="text-xl font-semibold">{t('docs.bulkH3')}</h3>
          <p className="text-gray-600 dark:text-gray-300">{t('docs.bulkP')}</p>

          <Box title={t('docs.bulkBoxOrder')}>
            <Bullets items={[
              'Введите фильтр строк в том же синтаксисе, что и в панели фильтра: col=\'a\' AND n>1. Условия соединяются через AND, OR не поддерживается — так же, как при чтении.',
              t('docs.bulkOrder2'),
              t('docs.bulkOrder3'),
              t('docs.bulkOrder4'),
              t('docs.bulkOrder5')
            ]} />
          </Box>

          <Box title={t('docs.bulkBoxHow')}>
            <Bullets items={[
              t('docs.bulkHow1'),
              t('docs.bulkHow2'),
              t('docs.bulkHow3'),
              t('docs.bulkHow4'),
              t('docs.bulkHow5')
            ]} />
          </Box>

          <Box title={t('docs.bulkBoxLimits')}>
            <Bullets items={[
              t('docs.bulkLimits1'),
              t('docs.bulkLimits2'),
              t('docs.bulkLimits3'),
              t('docs.bulkLimits4'),
              t('docs.bulkLimits5')
            ]} />
          </Box>

          <Box title={t('docs.bulkBoxNoPoint')}>
            <Bullets items={[
              t('docs.bulkNoPoint1'),
              t('docs.bulkNoPoint2'),
              t('docs.bulkNoPoint3')
            ]} />
          </Box>

          <p className="text-xs text-gray-500 dark:text-gray-400">{t('docs.bulkNote')}</p>
        </div>
      )
    },
    {
      id: 'sql',
      title: 'SQL',
      icon: <Code className="w-5 h-5 text-amber-500" />,
      content: (
        <div className="space-y-4">
          <h3 className="text-xl font-semibold">{t('docs.sqlH3')}</h3>
          <p className="text-gray-600 dark:text-gray-300">{t('docs.sqlP')}</p>

          <Box title={t('docs.sqlBoxButtons')}>
            <Bullets items={[
              t('docs.sqlButtons1'),
              t('docs.sqlButtons2'),
              t('docs.sqlButtons3'),
              t('docs.sqlButtons4'),
              t('docs.sqlButtons5'),
              t('docs.sqlButtons6'),
              t('docs.sqlButtons7')
            ]} />
          </Box>

          <Box title={t('docs.sqlBoxTemplates')}>
            <Bullets items={[
              t('docs.sqlTemplates1'),
              t('docs.sqlTemplates2'),
              t('docs.sqlTemplates3')
            ]} />
          </Box>

          <Box title={t('docs.sqlBoxMongo')}>
            <p className="text-sm text-gray-600 dark:text-gray-300">{t('docs.sqlMongoP1')}</p>
            <CodeBlock>{`{ "db": "app", "collection": "users", "filter": { "active": true }, "limit": 50 }
{ "collection": "logs", "clear": true }   // очистка по filter, защищена проверкой прав`}</CodeBlock>
            <p className="text-sm text-gray-600 dark:text-gray-300 mt-2">{t('docs.sqlMongoP2')}</p>
          </Box>

          <Box title={t('docs.sqlBoxRedis')}>
            <p className="text-sm text-gray-600 dark:text-gray-300">{t('docs.sqlRedisP1')}</p>
            <CodeBlock>{`{ "cmd": "KEYS",      "pattern": "user:*" }
{ "cmd": "GET",      "key": "user:1" }
{ "cmd": "HGETALL",  "key": "session:abc" }
{ "cmd": "SET",      "key": "k", "value": "v" }
{ "cmd": "DEL",      "key": "k" }`}</CodeBlock>
            <p className="text-sm text-gray-600 dark:text-gray-300 mt-2">{t('docs.sqlRedisP2')}</p>
          </Box>

          <Box title={t('docs.sqlBoxAudit')}>
            <Bullets items={[
              t('docs.sqlAudit1'),
              t('docs.sqlAudit2'),
              t('docs.sqlAudit3'),
              t('docs.sqlAudit4')
            ]} />
          </Box>

          <Box title={t('docs.sqlBoxPlan')}>
            <Bullets items={[
              t('docs.sqlPlan1'),
              t('docs.sqlPlan2'),
              t('docs.sqlPlan3'),
              t('docs.sqlPlan4')
            ]} />
          </Box>

          <Box title={t('docs.sqlBoxHistory')}>
            <Bullets items={[
              t('docs.sqlHistory1'),
              t('docs.sqlHistory2'),
              t('docs.sqlHistory3'),
              t('docs.sqlHistory4'),
              t('docs.sqlHistory5'),
              t('docs.sqlHistory6'),
              t('docs.sqlHistory7')
            ]} />
          </Box>

          <Box title={t('docs.sqlBoxCompat')}>
            <Bullets items={[
              t('docs.sqlCompat1'),
              t('docs.sqlCompat2')
            ]} />
          </Box>
        </div>
      )
    },
    {
      id: 'transfer',
      title: t('docs.tabTransfer'),
      icon: <ArrowRightLeft className="w-5 h-5 text-cyan-600" />,
      content: (
        <div className="space-y-4">
          <h3 className="text-xl font-semibold">{t('docs.transferH3')}</h3>
          <p className="text-gray-600 dark:text-gray-300">{t('docs.transferP')}</p>

          <Box title={t('table.export')}>
            <Bullets items={[
              t('docs.transferExport1'),
              t('docs.transferExport2'),
              t('docs.transferExport3'),
              t('docs.transferExport4'),
              t('docs.transferExport5'),
              t('docs.transferExport6')
            ]} />
          </Box>

          <Box title={t('docs.transferBoxImport')}>
            <Steps items={[
              t('docs.transferImport1'),
              t('docs.transferImport2'),
              t('docs.transferImport3'),
              t('docs.transferImport4')
            ]} />
            <Bullets items={[
              t('docs.transferImport5'),
              t('docs.transferImport6'),
              t('docs.transferImport7'),
              t('docs.transferImport8')
            ]} />
          </Box>

          <Box title={t('docs.transferBoxLimits')}>
            <Bullets items={[
              t('docs.transferLimits1'),
              t('docs.transferLimits2'),
              t('docs.transferLimits3'),
              t('docs.transferLimits4')
            ]} />
          </Box>
        </div>
      )
    },
    {
      id: 'models',
      title: t('docs.tabModels'),
      icon: <Boxes className="w-5 h-5 text-purple-500" />,
      content: (
        <div className="space-y-4">
          <h3 className="text-xl font-semibold">{t('docs.modelsH3')}</h3>
          <p className="text-gray-600 dark:text-gray-300">{t('docs.modelsP')}</p>

          <Box title={t('docs.modelsBoxWhat')}>
            <Bullets items={[
              t('docs.modelsWhat1'),
              t('docs.modelsWhat2'),
              t('docs.modelsWhat3'),
              t('docs.modelsWhat4')
            ]} />
          </Box>

          <Box title={t('docs.modelsBoxVersions')}>
            <Bullets items={[
              t('docs.modelsVersions1'),
              t('docs.modelsVersions2'),
              t('docs.modelsVersions3')
            ]} />
          </Box>

          <Box title={t('docs.modelsBoxApply')}>
            <Steps items={[
              t('docs.modelsApply1'),
              t('docs.modelsApply2'),
              t('docs.modelsApply3'),
              t('docs.modelsApply4')
            ]} />
            <Bullets items={[
              t('docs.modelsApply5'),
              t('docs.modelsApply6'),
              t('docs.modelsApply7'),
              t('docs.modelsApply8')
            ]} />
          </Box>

          <Box title={t('docs.modelsBoxTypes')}>
            <p className="text-sm text-gray-600 dark:text-gray-300">{t('docs.modelsTypesP')}</p>
            <Bullets items={[
              t('docs.modelsTypes1'),
              t('docs.modelsTypes2'),
              t('docs.modelsTypes3'),
              t('docs.modelsTypes4'),
              t('docs.modelsTypes5'),
              t('docs.modelsTypes6')
            ]} />
          </Box>

          <Box title={t('docs.modelsBoxCompare')}>
            <Bullets items={[
              t('docs.modelsCompare1'),
              t('docs.modelsCompare2'),
              t('docs.modelsCompare3')
            ]} />
          </Box>
        </div>
      )
    },
    {
      id: 'access',
      title: t('docs.tabAccess'),
      icon: <Shield className="w-5 h-5 text-indigo-500" />,
      content: (
        <div className="space-y-4">
          <h3 className="text-xl font-semibold">{t('docs.tabAccess')}</h3>
          <p className="text-gray-600 dark:text-gray-300">{t('docs.accessP')}</p>

          <Box title={t('docs.accessBoxLevel1')}>
            <Bullets items={[
              t('docs.accessL1_1'),
              t('docs.accessL1_2'),
              t('docs.accessL1_3'),
              t('docs.accessL1_4'),
              t('docs.accessL1_5'),
              t('docs.accessL1_6'),
              t('docs.accessL1_7')
            ]} />
          </Box>

          <Box title={t('docs.accessBoxRoles')}>
            <Bullets items={[
              t('docs.accessRoles1'),
              t('docs.accessRoles2'),
              t('docs.accessRoles3')
            ]} />
          </Box>

          <Box title={t('docs.accessBoxLevel2')}>
            <Bullets items={[
              t('docs.accessL2_1'),
              t('docs.accessL2_2'),
              t('docs.accessL2_3'),
              t('docs.accessL2_4'),
              t('docs.accessL2_5'),
              t('docs.accessL2_6'),
              t('docs.accessL2_7')
            ]} />
          </Box>

          <Box title={t('docs.accessBoxImportant')}>
            <Bullets items={[
              t('docs.accessImportant1'),
              t('docs.accessImportant2'),
              t('docs.accessImportant3')
            ]} />
          </Box>
        </div>
      )
    },
    {
      id: 'backups',
      title: t('docs.tabBackups'),
      icon: <HardDriveDownload className="w-5 h-5 text-purple-500" />,
      content: (
        <div className="space-y-4">
          <h3 className="text-xl font-semibold">{t('docs.backupsH3')}</h3>
          <p className="text-gray-600 dark:text-gray-300">{t('docs.backupsP')}</p>

          <Box title={t('docs.backupsBoxSchedule')}>
            <Steps items={[
              t('docs.backupsSchedule1'),
              t('docs.backupsSchedule2'),
              t('docs.backupsSchedule3'),
              t('docs.backupsSchedule4'),
              t('docs.backupsSchedule5')
            ]} />
          </Box>

          <Box title={t('docs.backupsBoxHow')}>
            <Bullets items={[
              t('docs.backupsHow1'),
              t('docs.backupsHow2'),
              t('docs.backupsHow3'),
              t('docs.backupsHow4'),
              t('docs.backupsHow5')
            ]} />
          </Box>

          <Box title={t('docs.backupsBoxRights')}>
            <Bullets items={[
              t('docs.backupsRights1'),
              t('docs.backupsRights2'),
              t('docs.backupsRights3'),
              t('docs.backupsRights4'),
              t('docs.backupsRights5'),
              t('docs.backupsRights6')
            ]} />
          </Box>
        </div>
      )
    },
    {
      id: 'monitoring',
      title: t('docs.tabMonitoring'),
      icon: <Activity className="w-5 h-5 text-green-500" />,
      content: (
        <div className="space-y-4">
          <h3 className="text-xl font-semibold">{t('docs.monitoringH3')}</h3>
          <p className="text-gray-600 dark:text-gray-300">{t('docs.monitoringP')}</p>

          <Box title={t('docs.monitoringBoxShows')}>
            <Bullets items={[
              t('docs.monitoringShows1'),
              t('docs.monitoringShows2'),
              t('docs.monitoringShows3'),
              t('docs.monitoringShows4')
            ]} />
          </Box>

          <Box title={t('docs.monitoringBoxDiff')}>
            <p className="text-sm text-gray-600 dark:text-gray-300">{t('docs.monitoringDiff1')}</p>
            <p className="text-sm text-gray-600 dark:text-gray-300 mt-2">{t('docs.monitoringDiff2')}</p>
          </Box>

          <Box title={t('docs.monitoringBoxRight')}>
            <Bullets items={[
              t('docs.monitoringRight1'),
              t('docs.monitoringRight2'),
              t('docs.monitoringRight3'),
              t('docs.monitoringRight4')
            ]} />
          </Box>

          <Box title={t('docs.monitoringBoxCalc')}>
            <Bullets items={[
              t('docs.monitoringCalc1'),
              t('docs.monitoringCalc2'),
              t('docs.monitoringCalc3')
            ]} />
          </Box>
        </div>
      )
    },
    {
      id: 'dialects',
      title: t('docs.tabDialects'),
      icon: <Layers className="w-5 h-5 text-teal-500" />,
      content: (
        <div className="space-y-4">
          <h3 className="text-xl font-semibold">{t('docs.dialectsH3')}</h3>
          <p className="text-gray-600 dark:text-gray-300">{t('docs.dialectsP')}</p>

          <Box title={t('docs.dialectsBoxMysql')}>
            <Bullets items={[
              t('docs.mysql1'),
              t('docs.mysql2'),
              t('docs.mysql3'),
              t('docs.mysql4'),
              t('docs.mysql5'),
              t('docs.mysql6'),
              t('docs.mysql7'),
              t('docs.mysql8'),
              t('docs.mysql9'),
              t('docs.mysql10')
            ]} />
          </Box>

          <Box title={t('docs.dialectsBoxPostgres')}>
            <Bullets items={[
              t('docs.pg1'),
              t('docs.pg2'),
              t('docs.pg3'),
              t('docs.pg4'),
              t('docs.pg5'),
              t('docs.pg6'),
              t('docs.pg7'),
              t('docs.pg8'),
              t('docs.pg9')
            ]} />
          </Box>

          <Box title={t('docs.dialectsBoxSqlite')}>
            <Bullets items={[
              t('docs.sqlite1'),
              t('docs.sqlite2'),
              t('docs.sqlite3'),
              t('docs.sqlite4'),
              t('docs.sqlite5'),
              t('docs.sqlite6'),
              t('docs.sqlite7'),
              t('docs.sqlite8'),
              t('docs.sqlite9')
            ]} />
          </Box>

          <Box title={t('docs.dialectsBoxMongo')}>
            <Bullets items={[
              t('docs.mongo1'),
              t('docs.mongo2'),
              t('docs.mongo3'),
              t('docs.mongo4'),
              t('docs.mongo5'),
              t('docs.mongo6'),
              t('docs.mongo7')
            ]} />
          </Box>

          <Box title={t('docs.dialectsBoxRedis')}>
            <Bullets items={[
              t('docs.redis1'),
              t('docs.redis2'),
              t('docs.redis3'),
              t('docs.redis4'),
              t('docs.redis5'),
              t('docs.redis6'),
              t('docs.redis7')
            ]} />
          </Box>

          <Box title={t('docs.dialectsBoxOracle')}>
            <Bullets items={[
              t('docs.oracle1'),
              t('docs.oracle2'),
              t('docs.oracle3'),
              t('docs.oracle4'),
              t('docs.oracle5'),
              t('docs.oracle6'),
              t('docs.oracle7')
            ]} />
          </Box>

          <Box title={t('docs.dialectsBoxCommon')}>
            <Bullets items={[
              t('docs.common1'),
              t('docs.common2'),
              t('docs.common3'),
              t('docs.common4'),
              t('docs.common5'),
              t('docs.common6')
            ]} />
          </Box>
        </div>
      )
    },
    {
      id: 'troubleshoot',
      title: 'Troubleshooting',
      icon: <LifeBuoy className="w-5 h-5 text-red-500" />,
      content: (
        <div className="space-y-4">
          <h3 className="text-xl font-semibold">{t('docs.troubleH3')}</h3>
          <p className="text-gray-600 dark:text-gray-300">{t('docs.troubleP')}</p>

          <Box title={t('docs.troubleBoxUi')}>
            <Bullets items={[
              t('docs.troubleUi1'),
              t('docs.troubleUi2'),
              t('docs.troubleUi3'),
              t('docs.troubleUi4'),
              t('docs.troubleUi5')
            ]} />
          </Box>

          <Box title={t('docs.troubleBoxApi')}>
            <Bullets items={[
              t('docs.troubleApi1'),
              t('docs.troubleApi2'),
              t('docs.troubleApi3'),
              t('docs.troubleApi4'),
              t('docs.troubleApi5'),
              t('docs.troubleApi6'),
              t('docs.troubleApi7'),
              t('docs.troubleApi8'),
              t('docs.troubleApi9'),
              t('docs.troubleApi10'),
              t('docs.troubleApi11'),
              t('docs.troubleApi12'),
              t('docs.troubleApi13'),
              t('docs.troubleApi14')
            ]} />
          </Box>

          <Box title={t('docs.troubleBoxEmpty')}>
            <Bullets items={[
              t('docs.troubleEmpty1'),
              t('docs.troubleEmpty2'),
              t('docs.troubleEmpty3'),
              t('docs.troubleEmpty4'),
              t('docs.troubleEmpty5'),
              t('docs.troubleEmpty6'),
              t('docs.troubleEmpty7'),
              t('docs.troubleEmpty8')
            ]} />
          </Box>

          <Box title={t('docs.tabTransfer')}>
            <Bullets items={[
              t('docs.troubleImport1'),
              t('docs.troubleImport2'),
              t('docs.troubleImport3'),
              t('docs.troubleImport4'),
              t('docs.troubleImport5')
            ]} />
          </Box>
        </div>
      )
    },
    {
      id: 'api',
      title: t('docs.tabApi'),
      icon: <FileJson className="w-5 h-5 text-gray-500 dark:text-gray-400" />,
      content: (
        <div className="space-y-4">
          <h3 className="text-xl font-semibold">{t('docs.apiH3')}</h3>
          <p className="text-gray-600 dark:text-gray-300">{t('docs.apiP')}</p>

          <Box title={t('docs.apiBoxWhere')}>
            <CodeBlock>{`GET /docs        Swagger UI — интерактивный справочник
GET /docs/json   спецификация OpenAPI в JSON
GET /docs/yaml   спецификация OpenAPI в YAML`}</CodeBlock>
            <Bullets items={[
              t('docs.apiWhere1'),
              t('docs.apiWhere2')
            ]} />
          </Box>

          <Box title={t('docs.apiBoxAuth')}>
            <Bullets items={[
              t('docs.apiAuth1'),
              t('docs.apiAuth2'),
              t('docs.apiAuth3'),
              t('docs.apiAuth4')
            ]} />
          </Box>

          <Box title={t('docs.apiBoxGroups')}>
            <Bullets items={[
              t('docs.apiGroups1'),
              t('docs.apiGroups2'),
              t('docs.apiGroups3'),
              t('docs.apiGroups4'),
              t('docs.apiGroups5'),
              t('docs.apiGroups6'),
              t('docs.apiGroups7'),
              t('docs.apiGroups8'),
              t('docs.apiGroups9')
            ]} />
          </Box>

          <Box title={t('docs.apiBoxCodes')}>
            <Bullets items={[
              t('docs.apiCodes1'),
              t('docs.apiCodes2'),
              t('docs.apiCodes3'),
              t('docs.apiCodes4')
            ]} />
          </Box>
        </div>
      )
    }
  ];

  const activeDoc = docs.find(d => d.id === activeTab);

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-in fade-in duration-200 overflow-y-auto">
 <div className="bg-white dark:bg-[#151923] rounded-xl shadow-xl w-full max-w-6xl h-[80vh] max-h-[92vh] my-auto flex flex-col overflow-hidden border border-gray-200 dark:border-gray-800">
        
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between shrink-0 bg-white dark:bg-[#1e2330]">
          <h2 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <Book className="w-6 h-6 text-blue-500" />{t('docs.modalTitle')}</h2>
          <button onClick={onClose} className="p-2 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 flex overflow-hidden min-w-0">
          {/* Sidebar */}
          <div className="w-64 shrink-0 border-r border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-[#1e2330]/50 overflow-y-auto overflow-x-hidden p-4 space-y-2">
            {docs.map(doc => (
              <button
                key={doc.id}
                onClick={() => setActiveTab(doc.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  activeTab === doc.id
                    ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400'
                    : 'text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-800'
                }`}
              >
                {doc.icon}
                {doc.title}
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden p-8 bg-white dark:bg-[#151923] text-gray-900 dark:text-white">
            {activeDoc?.content}
          </div>
        </div>

      </div>
    </div>
  );
}
