import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

// AES-256-GCM. Формат: salt(16):iv(12):tag(16):ciphertext (всё hex, разделено ':')
export function encrypt(plain: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes hex (64 chars)');
  const salt = randomBytes(16);
  const k = scryptSync(key, salt, 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${salt.toString('hex')}:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function decrypt(payload: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const [saltH, ivH, tagH, dataH] = payload.split(':');
  if (!saltH || !ivH || !tagH || !dataH) throw new Error('Bad cipher payload');
  const k = scryptSync(key, Buffer.from(saltH, 'hex'), 32);
  const decipher = createDecipheriv('aes-256-gcm', k, Buffer.from(ivH, 'hex'));
  decipher.setAuthTag(Buffer.from(tagH, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataH, 'hex')), decipher.final()]).toString('utf8');
}
