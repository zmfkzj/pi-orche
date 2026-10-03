export const copy=value=>structuredClone(value);export function normalizeProfile(value){return {...value,name:String(value.name??'')};}
