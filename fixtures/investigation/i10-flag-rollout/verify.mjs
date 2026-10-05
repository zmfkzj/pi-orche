import { isEnabled } from './repo/src/flags.js';
import { bucket } from './repo/src/hash.js';
const env = { FLAG_DARK_MODE: 'off' };
if (bucket('new-checkout', 'u-42') !== 14) throw new Error('bucket ' + bucket('new-checkout', 'u-42'));
if (isEnabled('new-checkout', 'u-42', env) !== true) throw new Error('u-42');
if (isEnabled('new-checkout', 'u-3', env) !== false) throw new Error('u-3');
if (bucket('new-checkout', 'u-3') !== 29) throw new Error('u-3 bucket');
console.log('ok i10');
