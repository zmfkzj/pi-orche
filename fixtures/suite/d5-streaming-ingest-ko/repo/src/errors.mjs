export function rowError(code,line){return Object.assign(new Error(`${code} at line ${line}`),{code,line});}
