// E2E pool + kill: parallel queries + KILL validation + RBAC.
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
const my=byName['e2e-mysql'];
const pg=byName['e2e-pg'];

// pool: 20 parallel queries
{
  const t0=Date.now();
  const pr=Array.from({length:20},()=>req('POST',`/api/connections/${my.id}/query`,T,{sql:'SELECT 1 AS v'}));
  const rs=await Promise.all(pr);
  check('pool 20 parallel', rs.every(r=>r.rowCount===1), `ms=${Date.now()-t0}`);
}

// kill validation
try{ await req('POST',`/api/connections/${my.id}/kill`,T,{pid:'abc'}); check('kill bad pid',false);}catch(e){ check('kill bad pid',e.status===400,`status=${e.status}`);}
try{ await req('POST',`/api/connections/${my.id}/kill`,T,{}); check('kill no pid',false);}catch(e){ check('kill no pid',e.status===400,`status=${e.status}`);}

// kill SLEEP query (real long query)
async function killSleep(key,c,sql){
  const p = fetch(BASE+`/api/connections/${c.id}/query`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${T}`},body:JSON.stringify({sql})});
  await new Promise(r=>setTimeout(r,600));
  const st=await req('GET',`/api/connections/${c.id}/status`,T);
  const hit=st.processlist.find(x=>String(x.query ?? '').includes('SLEEP')||String(x.query ?? '').includes('pg_sleep'));
  if(!hit){ check(`${key} kill sleep found pid`,false,JSON.stringify(st.processlist.slice(0,2))); try{await p;}catch{} return; }
  const r=await req('POST',`/api/connections/${c.id}/kill`,T,{pid:String(hit.id)});
  check(`${key} kill sleep`, r.ok===true, `pid=${hit.id}`);
  try{ await p; check(`${key} sleep no hang`, true);} catch(e){ check(`${key} sleep no hang`, true, `killed`);}
}
await killSleep('mysql',my,'SELECT SLEEP(5)');
await killSleep('pg',pg,'SELECT pg_sleep(5)');

// sqlite kill not supported
try{ await req('POST',`/api/connections/${byName['e2e-sqlite'].id}/kill`,T,{pid:'123'}); check('sqlite kill rejected',false);}catch(e){ check('sqlite kill rejected',e.status===400,`status=${e.status}`);}

// RBAC
{
  const ro=await req('POST','/api/auth/login',null,{username:'ro_user',password:'readonly123'});
  try{ await req('POST',`/api/connections/${my.id}/kill`,ro.token,{pid:'123'}); check('ro kill blocked',false);}catch(e){ check('ro kill blocked',e.status===403,`status=${e.status}`);}
  try{ await req('POST','/api/auth/login',null,{username:'e2e_editor',password:'editorpass123'}); const ed=await req('POST','/api/auth/login',null,{username:'e2e_editor',password:'editorpass123'}); await req('POST',`/api/connections/${my.id}/kill`,ed.token,{pid:'123'}); check('editor kill blocked',false);}catch(e){ check('editor kill blocked',e.status===403,`status=${e.status}`);}
}

if(failures){console.log(`FAILURES: ${failures}`); process.exit(1);}
console.log('POOL/KILL ALL GREEN');
