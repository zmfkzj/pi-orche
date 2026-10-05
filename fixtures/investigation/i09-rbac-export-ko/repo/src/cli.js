import { can } from './rbac.js';
const [user, permission] = process.argv.slice(2);
console.log(can(user, permission));
