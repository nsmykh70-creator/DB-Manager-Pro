// E2E history: auto-log + save/patch/delete + filter + RBAC.
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

// clean: delete existing history for this user/conn (by listing and deleting saved)
let hist0=await req('GET',`/api/history?connId=${sq.id}`,T);
for(const h of hist0.filter(x=>x.sql.includes('HIST_E2E'))){
  await req('DELETE',`/api/history/${h.id}`,T).catch(()=>{});
}

// auto history via query
await req('POST',`/api/connections/${sq.id}/query`,T,{sql:'SELECT 1 AS HIST_E2E'});
let hist1=await req('GET',`/api/history?connId=${sq.id}`,T);
check('auto history', hist1.some(x=>x.sql.includes('HIST_E2E')), `found ${hist1.length}`);

// save manually
const saved=await req('POST','/api/history',T,{connId:sq.id, db:'main', sql:'SELECT 2 AS HIST_E2E_SAVE', name:'my save'});
check('save', !!saved.id && saved.saved===1, saved.id);
let savedOnly=await req('GET','/api/history?savedOnly=1',T);
check('savedOnly', savedOnly.some(x=>x.id===saved.id), `len=${savedOnly.length}`);

// patch unsave
await req('PATCH',`/api/history/${saved.id}`,T,{saved:false});
let savedOnly2=await req('GET','/api/history?savedOnly=1',T);
check('unsave', !savedOnly2.some(x=>x.id===saved.id), '');

// patch name
await req('PATCH',`/api/history/${saved.id}`,T,{name:'renamed', saved:true});
let afterPatch=await req('GET',`/api/history?savedOnly=1`,T);
check('rename', afterPatch.some(x=>x.id===saved.id && x.name==='renamed'), '');

// search q
let qres=await req('GET',`/api/history?q=renamed`,T);
check('search q', qres.some(x=>x.id===saved.id), `q len=${qres.length}`);

// delete
await req('DELETE',`/api/history/${saved.id}`,T);
let afterDel=await req('GET',`/api/history?connId=${sq.id}`,T);
check('delete', !afterDel.some(x=>x.id===saved.id), '');

// RBAC: other user cannot delete
const saved2=await req('POST','/api/history',T,{connId:sq.id, sql:'SELECT 3 AS HIST_E2E_OTHER', name:'other'});
try{ await req('POST','/api/auth/login',null,{username:'ro_user',password:'readonly123'}).then(async ro=>{ const rt=ro.token; await req('DELETE',`/api/history/${saved2.id}`,rt); }); check('cross user delete blocked',false);}catch(e){ check('cross user delete blocked',e.status===403 || e.status===401,`status=${e.status}`);}
await req('DELETE',`/api/history/${saved2.id}`,T).catch(()=>{});

// anon blocked
try{ await req('GET','/api/history',null); check('anon blocked',false);}catch(e){ check('anon blocked',e.status===401,`status=${e.status}`);}

if(failures){console.log(`FAILURES: ${failures}`); process.exit(1);}
console.log('HISTORY ALL GREEN');
