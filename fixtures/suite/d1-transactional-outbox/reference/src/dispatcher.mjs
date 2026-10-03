import { copy } from './values.mjs';
export async function dispatch(db,send,{now,leaseMs,limit}){
 if(!Number.isSafeInteger(now)||!Number.isSafeInteger(leaseMs)||leaseMs<=0||!Number.isSafeInteger(limit)||limit<=0)throw new TypeError('invalid dispatch options');
 const claims=await db.transaction(tx=>tx.events.filter(e=>e.status==='pending'||(e.status==='claimed'&&e.until<=now)).slice(0,limit).map(e=>{e.status='claimed';e.until=now+leaseMs;e.owner=String(++tx.sequence);e.attempts++;return copy(e);}));
 let delivered=0,failed=0;
 await Promise.all(claims.map(async claim=>{let ok=true;try{await send(copy(claim));}catch{ok=false;}
 await db.transaction(tx=>{const e=tx.events.find(e=>e.id===claim.id);if(e.owner!==claim.owner||e.status!=='claimed')return;e.status=ok?'delivered':'pending';delete e.until;delete e.owner;});
 if(ok)delivered++;else failed++;
 }));return {delivered,failed};
}
