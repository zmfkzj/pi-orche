import {createHash} from 'node:crypto';export function fingerprint(source,dependencies){return createHash('sha256').update(JSON.stringify([source,dependencies])).digest('hex');}
