// E2E sqlite files: upload/list/download/delete + RBAC + bad name.
const BASE='http://localhost:3001';
let failures=0;
async function req(m,p,t,b){
  const h={...(t?{authorization:`Bearer ${t}`}:{})};
  let pl; if(b!==undefined){h['content-type']='application/json'; pl=JSON.stringify(b);}
  const r=await fetch(BASE+p,{method:m,headers:h,body:pl});
  const j=await r.json().catch(()=>({}));
  if(!r.ok){const e=new Error(`${m} ${p} -> ${r.status}: ${j.error??''}`); e.status=r.status; throw e;}
  return j;
}
function check(n,c,e=''){console.log((c?'PASS':'FAIL')+' '+n+(e?' | '+e:'')); if(!c) failures++;}

import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const login=await req('POST','/api/auth/login',null,{username:'admin',password:process.env.ADMIN_PASSWORD||''});
const T=login.token;

// ensure clean: list and delete any prior e2e files
let list0=await req('GET','/api/sqlite/files',T);
for(const f of list0.filter(x=>x.name.startsWith('e2e_'))){
  await req('DELETE',`/api/sqlite/files/${f.name}`,T).catch(()=>{});
}

// create temp sqlite file
const tmpName='e2e_test_'+Math.floor(Math.random()*10000)+'.db';
const tmpPath=join(tmpdir(),tmpName);
mkdirSync(tmpdir(), {recursive:true});
{
  const db=new Database(tmpPath);
  db.exec('CREATE TABLE t(x TEXT); INSERT INTO t VALUES (\'hello\');');
  db.close();
}
const buf=await (await import('node:fs/promises')).readFile(tmpPath);

// upload
{
  const fd=new FormData();
  fd.append('file', new Blob([buf]), tmpName);
  const r=await fetch(BASE+'/api/sqlite/files',{method:'POST',headers:{authorization:`Bearer ${T}`},body:fd});
  const j=await r.json().catch(()=>({}));
  check('upload', r.ok && j.name===tmpName, `${r.status} ${j.name}`);
}

// list
let list1=await req('GET','/api/sqlite/files',T);
check('list has file', list1.some(x=>x.name===tmpName), list1.map(x=>x.name).join(','));

// download
{
  const r=await fetch(BASE+`/api/sqlite/files/${tmpName}/download`,{headers:{authorization:`Bearer ${T}`}});
  check('download', r.ok && r.headers.get('content-type')?.includes('octet-stream'), `status=${r.status}`);
  const b=await r.arrayBuffer();
  check('download size', b.byteLength>0, `len=${b.byteLength}`);
}

// create connection using uploaded file and query
// ВАЖНО: файл лежит в ФС backend-а. Если backend в Docker (/data/sqlite),
// хостовый tmpdir недоступен — поэтому путь ищем перебором каталогов, а
// существование файла проверяем через сам API, а не через node:fs хоста.
// DELETE /api/connections/:id без dropDatabase=1 стирает только metadata:
// файл удаляется лишь при dropDatabase=1 (проверяем оба случая).
const connName='e2e-sqlite-file';
async function probeDir(dir){
  // Именно строковая склейка: path.join на Windows превратил бы '/data/sqlite'
  // в '\data\sqlite', и backend создал бы файл с таким именем вместо нашего.
  const file=`${dir.replace(/[\\/]+$/,'')}/${tmpName}`;
  const c=await req('POST','/api/connections',T,{name:connName,kind:'sqlite',filePath:file});
  console.log(`  probe ${dir} -> stored filePath=${c.filePath}`);
  try{
    const q=await req('POST',`/api/connections/${c.id}/query`,T,{sql:'SELECT * FROM t'});
    return {conn:c,rows:q.rows,file};
  }catch(e){ console.log(`  probe ${dir} failed: ${e.message}`); await req('DELETE',`/api/connections/${c.id}`,T).catch(()=>{}); return null; }
}
const candidates=(process.env.E2E_SQLITE_DIR? [process.env.E2E_SQLITE_DIR]:[]).concat([
  '/data/sqlite',
  join(process.cwd(),'backend','data','sqlite'),
]);
let probed=null;
for(const dir of candidates){ probed=await probeDir(dir); if(probed) break; }
check('backend sees uploaded file', !!probed, probed? probed.file : `tried: ${candidates.join(', ')}`);
if(probed){
  const {conn,rows,file}=probed;
  check('query file', rows.length===1 && rows[0].x==='hello', JSON.stringify(rows));
  await req('DELETE',`/api/connections/${conn.id}`,T);
  let afterMeta=await req('GET','/api/sqlite/files',T);
  check('metadata delete keeps file', afterMeta.some(x=>x.name===tmpName), file);
  const c2=await req('POST','/api/connections',T,{name:connName,kind:'sqlite',filePath:file});
  await req('DELETE',`/api/connections/${c2.id}?dropDatabase=1`,T);
  let afterDrop=await req('GET','/api/sqlite/files',T);
  check('dropDatabase=1 removes file', !afterDrop.some(x=>x.name===tmpName), file);
}

// Windows-путь в filePath: на POSIX должен быть отвергнут (400), иначе backend
// создаёт файл-мусор с обратными слэшами в имени; на Windows-хосте путь
// нормализуется в прямые слэши. В обоих случаях в meta.db не должно быть
// имени с '\'.
{
  const winPath='C:\\data\\e2e_winpath.db';
  let status=0, stored=null;
  try{
    const c=await req('POST','/api/connections',T,{name:'e2e-sqlite-winpath',kind:'sqlite',filePath:winPath});
    status=200; stored=c.filePath;
    await req('DELETE',`/api/connections/${c.id}`,T).catch(()=>{});
  }catch(e){ status=e.status??0; }
  const rejected=status===400;
  const normalized=stored!==null && !String(stored).includes('\\');
  check('backslash filePath rejected or normalized', rejected||normalized,
    `status=${status} stored=${JSON.stringify(stored)}`);
}

// bad filename (invalid chars)
{
  const fd=new FormData();
  fd.append('file', new Blob([buf]), 'bad;name.db');
  const r=await fetch(BASE+'/api/sqlite/files',{method:'POST',headers:{authorization:`Bearer ${T}`},body:fd});
  check('bad name rejected', r.status===400, `status=${r.status}`);
}

// RBAC readonly
{
  const ro=await req('POST','/api/auth/login',null,{username:'ro_user',password:'readonly123'});
  const fd=new FormData();
  fd.append('file', new Blob([buf]), 'ro_test.db');
  const r=await fetch(BASE+'/api/sqlite/files',{method:'POST',headers:{authorization:`Bearer ${ro.token}`},body:fd});
  check('ro upload blocked', r.status===403, `status=${r.status}`);
  try{ await req('DELETE',`/api/sqlite/files/${tmpName}`,ro.token); check('ro delete blocked',false);}catch(e){ check('ro delete blocked',e.status===403,`status=${e.status}`);}
}

// delete (admin) — файл уже мог быть удалён шагом dropDatabase=1 выше
{
  const before=await req('GET','/api/sqlite/files',T);
  if(before.some(x=>x.name===tmpName)){
    const r=await req('DELETE',`/api/sqlite/files/${tmpName}`,T);
    check('delete', r.ok===true, JSON.stringify(r));
  } else {
    check('delete', true, 'already removed by dropDatabase=1');
  }
  let list2=await req('GET','/api/sqlite/files',T);
  check('gone', !list2.some(x=>x.name===tmpName), '');
}

try{ unlinkSync(tmpPath);}catch{}
if(failures){console.log(`FAILURES: ${failures}`); process.exit(1);}
console.log('SQLITE FILES ALL GREEN');
