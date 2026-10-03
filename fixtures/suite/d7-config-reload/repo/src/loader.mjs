import {resolve} from 'node:path';import {DEFAULTS} from './defaults.mjs';import {merge,freeze} from './merge.mjs';import {validate} from './validation.mjs';
export async function loadConfig(path,{read,defaults=DEFAULTS}){return freeze(validate(merge(defaults,JSON.parse(await read(resolve(path))))));}
