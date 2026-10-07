import { createHmac, randomBytes } from 'node:crypto';

/**
 * TOTP по RFC 6238 (SHA-1, шаг 30 с, 6 цифр) для двухфакторки панели.
 * Своя реализация вместо otplib: зависимости не нужны, а алгоритм —
 * десяток строк поверх HMAC. Секрет хранится в users.totpSecret (base32),
 * флаг — в users.totpEnabled.
 */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = String(text).trim().replace(/=+$/, '').toUpperCase();
  if (!/^[A-Z2-7]+$/.test(clean)) throw new Error('Bad base32 secret');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Новый секрет (160 бит — как у Google Authenticator по умолчанию). */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

/** otpauth:// URL для ручного ввода в приложение-аутентификатор. */
export function otpauthUrl(secret: string, username: string, issuer = 'DBPanel'): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(username)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;
}

function hotp(secret: Buffer, counter: bigint): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter);
  const hmac = createHmac('sha1', secret).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

/** Код на момент времени (по умолчанию — сейчас). */
export function totpNow(secret: string, atMs = Date.now()): string {
  const counter = BigInt(Math.floor(atMs / 30_000));
  return hotp(base32Decode(secret), counter);
}

/**
 * Проверка кода с допуском ±1 шаг (расхождение часов телефона и сервера).
 * Формат строгий: ровно 6 цифр — пробелы и прочий мусор не чистим, а отвергаем.
 */
export function verifyTotp(secret: string, code: string, atMs = Date.now()): boolean {
  if (!/^\d{6}$/.test(String(code ?? ''))) return false;
  const step = BigInt(Math.floor(atMs / 30_000));
  const key = base32Decode(secret);
  return [-1n, 0n, 1n].some((drift) => hotp(key, step + drift) === code);
}
