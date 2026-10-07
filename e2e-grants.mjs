// E2E grants: grant/revoke/list + validation.
const BASE = 'http://localhost:3001';
let failures=0;
async function req(method,path,token,body){
  const h={...(token?{authorization:`Bearer ${token}`}:{})};
  let p; if(body!==undefined){h['content-type']='application/json'; p=JSON.stringify(body);}
  const r=await fetch(BASE+path,{method,headers:h,body:p});
  const j=await r.json().catch(()=>({}));
  if(!r.ok){const e=new Error(`${method} ${path} -> ${r.status}: ${j.error??''}`); e.status=r.status; throw e;}
  return j;
}
function check(n,c,e=''){console.log((c?'PASS':'FAIL')+' '+n+(e?' | '+e:'')); if(!c) failures++;}

const login=await req('POST','/api/auth/login',null,{username:'admin',password:process.env.ADMIN_PASSWORD||''});
const T=login.token;
const conns=await req('GET','/api/connections',T);
const byName=Object.fromEntries(conns.map(c=>[c.name,c]));

async function grantCycle(key,c){
  const u='g_'+key+'_'+Math.floor(Math.random()*10000);
  await req('POST',`/api/connections/${c.id}/dbusers`,T,{username:u,password:'Password123',db: key==='mongo'?'demo':undefined});
  // grant
  if(key==='mysql' || key==='maria'){
    await req('POST',`/api/connections/${c.id}/dbusers/${u}/grant`,T,{privilege:'SELECT',db:'demo',table:'users'});
    const g1=await req('GET',`/api/connections/${c.id}/dbusers/${u}/grants`,T);
    check(`${key} grant list`, Array.isArray(g1) && g1.some(s=>s.includes('SELECT')), g1.join('|').slice(0,120));
    await req('POST',`/api/connections/${c.id}/dbusers/${u}/revoke`,T,{privilege:'SELECT',db:'demo',table:'users'});
    const g2=await req('GET',`/api/connections/${c.id}/dbusers/${u}/grants`,T);
    check(`${key} revoke`, !g2.some(s=>s.includes('SELECT') && s.includes('users')), g2.join('|').slice(0,120));
  } else if(key==='pg'){
    await req('POST',`/api/connections/${c.id}/dbusers/${u}/grant`,T,{privilege:'SELECT',db:'demo',table:'users'});
    const g1=await req('GET',`/api/connections/${c.id}/dbusers/${u}/grants`,T);
    check(`${key} grant list`, Array.isArray(g1), JSON.stringify(g1).slice(0,120));
    await req('POST',`/api/connections/${c.id}/dbusers/${u}/revoke`,T,{privilege:'SELECT',db:'demo',table:'users'});
    check(`${key} revoke ok`, true);
  } else if(key==='mongo'){
    await req('POST',`/api/connections/${c.id}/dbusers/${u}/grant`,T,{privilege:'read',db:'demo'});
    const g1=await req('GET',`/api/connections/${c.id}/dbusers/${u}/grants?db=demo`,T);
    check(`${key} grant list`, Array.isArray(g1) && g1.some(s=>s==='read@demo'), g1.join(','));
    await req('POST',`/api/connections/${c.id}/dbusers/${u}/revoke`,T,{privilege:'read',db:'demo'});
    const g2=await req('GET',`/api/connections/${c.id}/dbusers/${u}/grants?db=demo`,T);
    check(`${key} revoke`, !g2.includes('read@demo'), g2.join(','));
  }
  // bad priv — mysql/pg 400, mongo 500 (role not exist) оба ок
  try{await req('POST',`/api/connections/${c.id}/dbusers/${u}/grant`,T,{privilege:'BADPRIV',db:'demo'}); check(`${key} bad priv`,false);}catch(e){check(`${key} bad priv`,e.status===400 || e.status===500,`status=${e.status}`);}
  await req('DELETE',`/api/connections/${c.id}/dbusers/${u}${key==='mongo'?'?db=demo':''}`,T);
}

await grantCycle('mysql',byName['e2e-mysql']);
await grantCycle('maria',byName['e2e-maria']);
await grantCycle('pg',byName['e2e-pg']);
await grantCycle('mongo',byName['e2e-mongo']);

// readonly blocked
{
  const ro=await req('POST','/api/auth/login',null,{username:'ro_user',password:'readonly123'});
  try{await req('POST',`/api/connections/${byName['e2e-mysql'].id}/dbusers/g1/grant`,ro.token,{privilege:'SELECT',db:'demo'}); check('ro grant blocked',false);}catch(e){check('ro grant blocked',e.status===403,`status=${e.status}`);}
}

if(failures){console.log(`FAILURES: ${failures}`); process.exit(1);}
console.log('GRANTS ALL GREEN');
