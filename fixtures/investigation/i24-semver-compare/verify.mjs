import { compareVersions } from './repo/src/version.js';
import { shouldUpdate } from './repo/src/updater.js';
if (compareVersions('1.0.0-beta.1', '1.0.0') !== 1) throw new Error('a');
if (compareVersions('1.0.0-rc', '1.0.0') !== 0) throw new Error('rc');
if (compareVersions('1.10.0', '1.9.0') <= 0) throw new Error('b');
if (shouldUpdate('1.0.0', '1.0.0-beta.1') !== true) throw new Error('downgrade');
if (shouldUpdate('1.0.0-beta.1', '1.0.0') !== false) throw new Error('c');
console.log('ok i24');
