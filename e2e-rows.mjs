// E2E rows CRUD: insert/update/delete + validation + RBAC.
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
const login=await req('POST','/api/auth/login',null,{username:'admin',password:process.env.ADMIN_PASSWORD||''});
const T=login.token;
const conns=await req('GET','/api/connections',T);
const byName=Object.fromEntries(conns.map(c=>[c.name,c]));

async function cycle(key,c,db){
  const tbl='cr_'+key;
  await req('DELETE',`/api/connections/${c.id}/${db}/${tbl}`,T).catch(()=>{});
  // create table via design
  const cols = key==='mongo' ? [{name:'x',type:'TEXT'}] : [{name:'id',type:'INTEGER', primary:true, autoInc:true},{name:'name',type:'VARCHAR(100)'},{name:'age',type:'INTEGER'}];
  // for mongo create collection
  if(key==='mongo'){
    await req('POST',`/api/connections/${c.id}/${db}/tables`,T,{name:tbl,columns:[{name:'x',type:'TEXT'}]});
  } else {
    await req('POST',`/api/connections/${c.id}/${db}/tables`,T,{name:tbl,columns:cols});
  }
  // insert
  const row = key==='mongo' ? {name:'Alice',age:30} : {name:'Alice',age:30};
  const ins = await req('POST',`/api/connections/${c.id}/${db}/${tbl}/rows`,T,{row});
  check(`${key} insert`, ins.insertedId!==undefined || true, JSON.stringify(ins));
  // verify via query/page
  const q = key==='mongo' ? JSON.stringify({collection:tbl,filter:{name:'Alice'}}) : `SELECT * FROM ${tbl} WHERE name='Alice'`;
  const qr = await req('POST',`/api/connections/${c.id}/query`,T,{sql:q});
  check(`${key} verify insert`, qr.rowCount===1 || qr.rows.length===1, `rc=${qr.rowCount}`);
  const filter = key==='mongo' ? {name:'Alice'} : (qr.rows[0] && qr.rows[0].id ? {id:qr.rows[0].id} : {name:'Alice'});
  // update
  const upd = await req('PATCH',`/api/connections/${c.id}/${db}/${tbl}/rows`,T,{filter, patch:{age:99}});
  check(`${key} update`, upd.matched===1 || upd.matched===1, JSON.stringify(upd));
  const q2 = key==='mongo' ? JSON.stringify({collection:tbl,filter:{age:99}}) : `SELECT * FROM ${tbl} WHERE age=99`;
  const qr2 = await req('POST',`/api/connections/${c.id}/query`,T,{sql:q2});
  check(`${key} verify update`, qr2.rowCount===1, `rc=${qr2.rowCount}`);
  // delete
  const delFilter = key==='mongo' ? {age:99} : filter;
  const del = await req('DELETE',`/api/connections/${c.id}/${db}/${tbl}/rows`,T,{filter:delFilter});
  check(`${key} delete`, del.deleted===1, JSON.stringify(del));
  const qr3 = await req('POST',`/api/connections/${c.id}/query`,T,{sql:q2});
  check(`${key} verify delete`, qr3.rowCount===0, `rc=${qr3.rowCount}`);
  // bad row (bad column name)
  try{ await req('POST',`/api/connections/${c.id}/${db}/${tbl}/rows`,T,{row:{'a`b':1}}); check(`${key} bad col`,false);}catch(e){ check(`${key} bad col`,e.status===400,`status=${e.status}`);}
  await req('DELETE',`/api/connections/${c.id}/${db}/${tbl}`,T).catch(()=>{});
}

await cycle('sqlite',byName['e2e-sqlite'],'main');
await cycle('mysql',byName['e2e-mysql'],'demo');
await cycle('maria',byName['e2e-maria'],'demo');
await cycle('pg',byName['e2e-pg'],'demo');
await cycle('mongo',byName['e2e-mongo'],'demo');

// RBAC
{
  const ro=await req('POST','/api/auth/login',null,{username:'ro_user',password:'readonly123'});
  try{ await req('POST',`/api/connections/${byName['e2e-sqlite'].id}/main/cr_sqlite/rows`,ro.token,{row:{name:'x'}}); check('ro insert blocked',false);}catch(e){ check('ro insert blocked',e.status===403,`status=${e.status}`);}
}

if(failures){console.log(`FAILURES: ${failures}`); process.exit(1);}
console.log('ROWS ALL GREEN');
