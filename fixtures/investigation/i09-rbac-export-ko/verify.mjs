import { can } from './repo/src/rbac.js';
if (can('mina', 'report:export') !== false) throw new Error('mina');
if (can('joon', 'report:export') !== false) throw new Error('joon also denied via inheritance');
console.log('ok i09');
