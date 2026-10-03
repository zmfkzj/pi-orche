export function createWorker(manager){return {settings:()=>{const config=manager.get();return {workers:config.limits.workers,audit:config.features.audit};}};}
