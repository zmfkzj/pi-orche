export async function retry(fn,attempts=2){let error;for(let i=0;i<attempts;i++){try{return await fn();}catch(e){error=e;}}throw error;}
