import { createPrivateKey, createPublicKey } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function requestIdentityPublicKey(pem) {
  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw Error('Restate signing requires an Ed25519 private key');
  const bytes = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = BigInt(`0x${bytes.toString('hex')}`), encoded = '';
  while (value) { encoded = alphabet[Number(value % 58n)] + encoded; value /= 58n; }
  for (const byte of bytes) { if (byte) break; encoded = '1' + encoded; }
  return `publickeyv1_${encoded}`;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.RESTATE_SIGNING_PRIVATE_KEY_PEM) throw Error('RESTATE_SIGNING_PRIVATE_KEY_PEM is required');
  console.log(requestIdentityPublicKey(process.env.RESTATE_SIGNING_PRIVATE_KEY_PEM));
}
