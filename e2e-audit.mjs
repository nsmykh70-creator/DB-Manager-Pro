// E2E audit: записи после операций + фильтр + RBAC.
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
const sq=conns.find(c=>c.name==='e2e-sqlite');
const before=await req('GET',`/api/audit?limit=5&connId=${sq.id}`,T);
const cntB=before.length;
await req('POST',`/api/connections/${sq.id}/query`,T,{sql:'SELECT 1'});
await req('GET',`/api/connections/${sq.id}/dbusers`,T).catch(()=>{});
await new Promise(r=>setTimeout(r,200));
const after=await req('GET',`/api/audit?limit=20&connId=${sq.id}`,T);
check('audit grows', after.length>cntB, `${cntB}->${after.length}`);
check('audit has query', after.some(x=>x.action==='query' && x.actor==='admin'), JSON.stringify(after.slice(0,2)));
check('audit has actor', after.every(x=>x.actor!==undefined), '');
const all=await req('GET','/api/audit?limit=5',T);
check('audit all', Array.isArray(all) && all.length>0, `len=${all.length}`);
// readonly blocked
const ro=await req('POST','/api/auth/login',null,{username:'ro_user',password:'readonly123'});
try{ await req('GET','/api/audit?limit=5',ro.token); check('ro audit blocked',false);}catch(e){check('ro audit blocked',e.status===403,`status=${e.status}`);}
if(failures){console.log(`FAILURES: ${failures}`); process.exit(1);}
console.log('AUDIT ALL GREEN');
