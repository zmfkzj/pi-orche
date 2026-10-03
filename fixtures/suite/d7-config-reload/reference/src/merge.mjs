import {invalid} from './validation.mjs';
export const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export function safe(value){if(value&&typeof value==='object'){for(const [key,child] of Object.entries(value)){if(['__proto__','constructor','prototype'].includes(key))invalid();safe(child);}}return value;}
export function merge(base,patch){safe(base);safe(patch);const result=structuredClone(base);for(const [key,value] of Object.entries(patch)){result[key]=isObject(value)&&isObject(result[key])?merge(result[key],value):structuredClone(value);}return result;}
export function freeze(value){if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
