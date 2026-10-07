// E2E двухфакторки: setup/enable/вход с кодом/отказ/выключение.
import { createHmac } from 'node:crypto';
const BASE = 'http://localhost:3001';
let failures = 0;

async function req(method, path, token, body) {
  const headers = { ...(token ? { authorization: `Bearer ${token}` } : {}) };
  let payload;
  if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(BASE + path, { method, headers, body: payload });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(`${method} ${path} -> ${r.status}: ${j.error ?? ''}`);
    e.status = r.status;
    e.body = j;
    throw e;
  }
  return j;
}

function check(name, cond, extra = '') {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' | ' + extra : ''));
  if (!cond) failures++;
}

// TOTP как на сервере (RFC 6238, SHA-1, 30с, 6 цифр).
function totp(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const bytes = [];
  for (const ch of secret.replace(/=+$/, '').toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const hmac = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(code % 1000000).padStart(6, '0');
}

const login = await req('POST', '/api/auth/login', null, { username: 'admin', password: process.env.ADMIN_PASSWORD || '' });
const T = login.token;
const USER = 'e2e_2fa';
const PASS = 'TwofaCheck123';
// чистка от прошлого падения
const existing = await req('GET', '/api/auth/users', T);
for (const u of existing.filter((x) => x.username === USER)) await req('DELETE', `/api/auth/users/${u.id}`, T).catch(() => {});
await req('POST', '/api/auth/users', T, { username: USER, password: PASS, role: 'editor' });

// вход без 2FA — полный токен сразу
const plain = await req('POST', '/api/auth/login', null, { username: USER, password: PASS });
check('login без 2FA — полный токен', Boolean(plain.token) && !plain.need2fa, plain.need2fa ? 'need2fa!' : '');
const UT = plain.token;

// включение без setup — 400
try {
  await req('POST', '/api/auth/2fa/enable', UT, { code: '123456' });
  check('enable без setup отклонён', false);
} catch (e) { check('enable без setup отклонён', e.status === 400, `status=${e.status}`); }

// setup требует пароль
try {
  await req('POST', '/api/auth/2fa/setup', UT, {});
  check('setup без пароля отклонён', false);
} catch (e) { check('setup без пароля отклонён', e.status === 400, `status=${e.status}`); }
const setup = await req('POST', '/api/auth/2fa/setup', UT, { password: PASS });
check('setup выдал секрет', typeof setup.secret === 'string' && setup.secret.length >= 16 && setup.otpauthUrl.includes('otpauth://totp/'), `len=${setup.secret?.length}`);

// неверный код — 401
try {
  await req('POST', '/api/auth/2fa/enable', UT, { code: '000000' });
  check('чужой код отклонён', totp(setup.secret) === '000000');
} catch (e) { check('чужой код отклонён', e.status === 401, `status=${e.status}`); }

await req('POST', '/api/auth/2fa/enable', UT, { code: totp(setup.secret) });
const status = await req('GET', '/api/auth/2fa/status', UT);
check('2FA включена', status.enabled === true, JSON.stringify(status));

// вход теперь двухшаговый
const step1 = await req('POST', '/api/auth/login', null, { username: USER, password: PASS });
check('вход с 2FA — нужен код', step1.need2fa === true && Boolean(step1.tempToken) && !step1.token, JSON.stringify(Object.keys(step1)));
// временный токен не даёт доступа к API
try {
  await req('GET', '/api/auth/me', step1.tempToken);
  check('temp-токен не пускает в API', false);
} catch (e) { check('temp-токен не пускает в API', e.status === 401, `status=${e.status}`); }
// неверный код на verify — 401
try {
  await req('POST', '/api/auth/2fa/verify', step1.tempToken, { code: '000000' });
  check('verify с чужим кодом отклонён', totp(setup.secret) === '000000');
} catch (e) { check('verify с чужим кодом отклонён', e.status === 401, `status=${e.status}`); }
const step2 = await req('POST', '/api/auth/2fa/verify', step1.tempToken, { code: totp(setup.secret) });
check('verify со своим кодом даёт токен', Boolean(step2.token) && Boolean(step2.user), '');
const me = await req('GET', '/api/auth/me', step2.token);
check('полный токен работает', me.user?.username === USER, JSON.stringify(me.user));

// выключение без пароля — 400, с паролем — ок
try {
  await req('POST', '/api/auth/2fa/disable', step2.token, {});
  check('disable без пароля отклонён', false);
} catch (e) { check('disable без пароля отклонён', e.status === 400, `status=${e.status}`); }
await req('POST', '/api/auth/2fa/disable', step2.token, { password: PASS });
const off = await req('GET', '/api/auth/2fa/status', step2.token);
check('2FA выключена', off.enabled === false, JSON.stringify(off));
const back = await req('POST', '/api/auth/login', null, { username: USER, password: PASS });
check('вход снова одношаговый', Boolean(back.token) && !back.need2fa, '');

// чистка
const users = await req('GET', '/api/auth/users', T);
for (const u of users.filter((x) => x.username === USER)) await req('DELETE', `/api/auth/users/${u.id}`, T);

if (failures) { console.log(`FAILURES: ${failures}`); process.exitCode = 1; }
else console.log('2FA ALL GREEN');
