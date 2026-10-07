// E2E docs: /docs/json public even with REQUIRE_AUTH=1, /api protected.
const BASE='http://localhost:3001';
let failures=0;
function check(n,c,e=''){console.log((c?'PASS':'FAIL')+' '+n+(e?' | '+e:'')); if(!c) failures++;}

// public docs
{
  const r=await fetch(BASE+'/docs/json');
  const j=await r.json().catch(()=>({}));
  check('docs public', r.ok && j.info && j.info.title==='DB Panel API', `status=${r.status} title=${j.info?.title}`);
  const h=await fetch(BASE+'/docs');
  check('docs html', h.ok, `status=${h.status}`);
}

// protected api still 401
{
  const r=await fetch(BASE+'/api/connections');
  check('api protected', r.status===401, `status=${r.status}`);
}

// with auth, api ok and docs still ok
{
  const login=await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:process.env.ADMIN_PASSWORD||''})});
  const j=await login.json();
  const tok=j.token;
  const r=await fetch(BASE+'/api/connections',{headers:{authorization:`Bearer ${tok}`}});
  check('api with auth', r.ok, `status=${r.status}`);
  const d=await fetch(BASE+'/docs/json',{headers:{authorization:`Bearer ${tok}`}});
  check('docs with auth', d.ok, `status=${d.status}`);
}

if(failures){console.log(`FAILURES: ${failures}`); process.exit(1);}
console.log('DOCS ALL GREEN');
