import { createHash, generateKeyPairSync } from 'node:crypto';

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

/** Настоящий публичный ключ ed25519 в формате OpenSSH и его отпечаток SHA256 (как у ssh-keygen -l). */
export function makeSshKey(comment = 'test@host'): { publicKey: string; blob: string; fingerprint: string } {
  const { publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
  const type = Buffer.from('ssh-ed25519');
  const blob = Buffer.concat([u32(type.length), type, u32(raw.length), raw]);
  return {
    publicKey: `ssh-ed25519 ${blob.toString('base64')} ${comment}`,
    blob: blob.toString('base64'),
    fingerprint: 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, ''),
  };
}

/** Целое число в формате mpint из RFC 4251: big-endian, перед старшим битом 1 добавляется нулевой байт. */
const mpint = (n: Buffer): Buffer => {
  let b = n;
  while (b.length > 1 && b[0] === 0) b = b.subarray(1);
  return b[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b;
};
const field = (b: Buffer): Buffer => Buffer.concat([u32(b.length), b]);
const finish = (type: string, parts: Buffer[], comment: string) => {
  const blob = Buffer.concat([field(Buffer.from(type)), ...parts.map(field)]);
  return { publicKey: `${type} ${blob.toString('base64')} ${comment}`, blob: blob.toString('base64') };
};

/** Настоящий ключ ssh-rsa: поля e и n (mpint). */
export function makeRsaKey(comment = 'rsa@host'): { publicKey: string; blob: string } {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  return finish('ssh-rsa', [mpint(Buffer.from(jwk.e as string, 'base64url')), mpint(Buffer.from(jwk.n as string, 'base64url'))], comment);
}

/** Настоящий ключ ecdsa-sha2-nistp256: имя кривой и несжатая точка 04 || x || y. */
export function makeEcdsaKey(comment = 'ecdsa@host'): { publicKey: string; blob: string } {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x as string, 'base64url'), Buffer.from(jwk.y as string, 'base64url')]);
  return finish('ecdsa-sha2-nistp256', [Buffer.from('nistp256'), point], comment);
}
