export function fail(code){throw Object.assign(new Error(code),{code});}
export function validString(value){return typeof value==='string'&&value.length>0;}
export function validateQuery({tenant,kind,limit,secret}){if(!validString(tenant)||(kind!==undefined&&!validString(kind))||!Number.isSafeInteger(limit)||limit<1||limit>100||!validString(secret))fail('INVALID_QUERY');}
