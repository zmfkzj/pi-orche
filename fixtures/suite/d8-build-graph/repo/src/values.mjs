export const copy=value=>structuredClone(value);export function fail(code){throw Object.assign(new Error(code),{code});}
