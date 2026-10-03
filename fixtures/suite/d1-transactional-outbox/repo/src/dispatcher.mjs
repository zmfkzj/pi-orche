import { pending } from './event-repository.mjs';
export async function dispatch(db, send, {now, leaseMs, limit}) {
 const events = await db.transaction(tx => pending(tx).slice(0, limit));
 let delivered = 0, failed = 0;
 await Promise.all(events.map(async event => {try {await send(event);event.status='delivered';delivered++;} catch {failed++;}}));
 return {delivered, failed};
}
