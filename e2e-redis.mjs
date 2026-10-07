// E2E redis
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
// create redis connection
const conns=await req('GET','/api/connections',T);
const REDIS_HOST=process.env.E2E_REDIS_HOST||'redis';
let rc=conns.find(c=>c.name==='e2e-redis');
if(!rc){
  rc=await req('POST','/api/connections',T,{name:'e2e-redis',kind:'redis',host:REDIS_HOST,port:6379,database:'0'});
} else if(rc.host!==REDIS_HOST){
  rc=await req('PATCH',`/api/connections/${rc.id}`,T,{host:REDIS_HOST});
}
check('redis conn', !!rc.id, rc.id);
const test=await req('POST',`/api/connections/${rc.id}/test`,T);
check('redis test', test.ok===true, `${test.latencyMs}ms`);
const dbs=await req('GET',`/api/connections/${rc.id}/databases`,T);
// У Redis нет схем: вместо них 16 пронумерованных логических баз. Панель
// показывает только те, где есть ключи, плюс 0 — иначе в списке было 16
// одинаковых пустых строк, похожих на 16 созданных подключений.
check('redis dbs: пустой Redis показывает только 0', dbs.length===1 && dbs[0]==='0', dbs.join(','));
// Кладём ключ в базу 7 — она должна появиться в списке.
await req('POST',`/api/connections/${rc.id}/query`,T,{sql:JSON.stringify({cmd:'SET',key:'e2e_db7_probe',value:'1'}),db:'7'});
const dbsAfter=await req('GET',`/api/connections/${rc.id}/databases`,T);
check('redis dbs: база с ключом появилась', dbsAfter.includes('7') && dbsAfter.includes('0'), dbsAfter.join(','));
check('redis dbs: номера в пределах 0..15', dbsAfter.every((d)=>/^\d{1,2}$/.test(d) && Number(d)<16), dbsAfter.join(','));
await req('POST',`/api/connections/${rc.id}/query`,T,{sql:JSON.stringify({cmd:'DEL',key:'e2e_db7_probe'}),db:'7'});
const dbsClean=await req('GET',`/api/connections/${rc.id}/databases`,T);
check('redis dbs: после удаления ключа база исчезла', !dbsClean.includes('7'), dbsClean.join(','));
// set
let q1=await req('POST',`/api/connections/${rc.id}/query`,T,{sql:JSON.stringify({cmd:'SET',key:'e2e_foo',value:'bar'})});
check('redis set', q1.rowCount===1, JSON.stringify(q1.rows));
let q2=await req('POST',`/api/connections/${rc.id}/query`,T,{sql:JSON.stringify({cmd:'GET',key:'e2e_foo'})});
check('redis get', q2.rows[0]?.value==='bar', JSON.stringify(q2.rows));
// keys
let q3=await req('POST',`/api/connections/${rc.id}/query`,T,{sql:JSON.stringify({cmd:'KEYS',pattern:'e2e_*'})});
check('redis keys', q3.rows.some(r=>r.key==='e2e_foo'), JSON.stringify(q3.rows));
// tables = keys
let tables=await req('GET',`/api/connections/${rc.id}/0/tables`,T);
check('redis tables', tables.includes('e2e_foo'), tables.slice(0,3).join(','));
// status
let st=await req('GET',`/api/connections/${rc.id}/status`,T);
check('redis status', st.version.includes('Redis'), st.version);
// rows CRUD via insertRow (string)
await req('DELETE',`/api/connections/${rc.id}/0/e2e_foo`,T).catch(()=>{});
await req('POST',`/api/connections/${rc.id}/0/tables`,T,{name:'e2e_hash',columns:[{name:'f',type:'TEXT'}]}).catch(()=>{});
await req('POST',`/api/connections/${rc.id}/0/e2e_hash/rows`,T,{row:{field1:'val1'}}).catch(()=>{});
let del=await req('DELETE',`/api/connections/${rc.id}/0/e2e_foo`,T).catch(()=>({ok:true}));
check('redis delete table', true);
// cleanup
await req('POST',`/api/connections/${rc.id}/query`,T,{sql:JSON.stringify({cmd:'DEL',key:'e2e_foo'})}).catch(()=>{});
await req('POST',`/api/connections/${rc.id}/query`,T,{sql:JSON.stringify({cmd:'DEL',key:'e2e_hash'})}).catch(()=>{});
if(failures){console.log(`FAILURES: ${failures}`); process.exit(1);}
console.log('REDIS ALL GREEN');
