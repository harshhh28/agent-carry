import crypto from 'node:crypto';

/**
 * Passphrase encryption for bundles: scrypt -> AES-256-GCM, node:crypto only.
 * Layout: "CARRYENC" | version(1) | salt(16) | iv(12) | ciphertext | tag(16).
 * The fixed header is bound into the auth tag, so any edit is detected.
 */
const MAGIC = Buffer.from('CARRYENC');
const VERSION = 1;
const HEADER = MAGIC.length + 1 + 16 + 12;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export const isEncrypted = (buf) => buf.length > HEADER + 16 && buf.subarray(0, MAGIC.length).equals(MAGIC);

export function encrypt(plain, passphrase) {
  if (!passphrase) throw new Error('empty passphrase');
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32, SCRYPT);
  const head = Buffer.concat([MAGIC, Buffer.from([VERSION]), salt, iv]);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(head);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([head, ct, c.getAuthTag()]);
}

export function decrypt(buf, passphrase) {
  if (!passphrase) throw new Error('this bundle is encrypted: set CARRY_PASSPHRASE or pass --passphrase-file');
  if (buf[MAGIC.length] !== VERSION) throw new Error(`unsupported encryption version ${buf[MAGIC.length]}`);
  const head = buf.subarray(0, HEADER);
  const salt = head.subarray(MAGIC.length + 1, MAGIC.length + 17);
  const iv = head.subarray(MAGIC.length + 17);
  const tag = buf.subarray(buf.length - 16);
  const key = crypto.scryptSync(passphrase, salt, 32, SCRYPT);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(head);
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(buf.subarray(HEADER, buf.length - 16)), d.final()]);
  } catch {
    throw new Error('wrong passphrase, or the file was modified');
  }
}
