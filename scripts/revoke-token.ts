import { Store } from '../src/core/store.js';
const path = process.env.MOTION_STATE_PATH;
const tokenId = process.argv[2];
if (!path || !tokenId)
  throw new Error(
    'Supply MOTION_STATE_PATH and the token jti (or SHA-256 of a token without jti). Never supply the token itself.'
  );
const store = new Store(path);
store.revoke(tokenId);
store.close();
console.log('Token identifier revoked.');
