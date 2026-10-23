// Prints a new VAPID key pair for Web Push as .env lines.
//   npm run vapid:generate             # print
//   npm run vapid:generate >> .env     # append to a file
// Generate once per environment and keep it: changing the pair orphans every
// subscription diners have made.
import { createECDH } from 'node:crypto';

const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
console.log(`VAPID_PUBLIC_KEY=${ecdh.getPublicKey().toString('base64url')}`);
// Always 32 bytes: a key with leading zero bytes can come back shorter.
const privateKey = ecdh.getPrivateKey();
console.log(`VAPID_PRIVATE_KEY=${Buffer.concat([Buffer.alloc(32 - privateKey.length), privateKey]).toString('base64url')}`);
