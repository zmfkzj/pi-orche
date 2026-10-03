export function createWorker(manager){const config=manager.get();return {settings:()=>({workers:config.limits.workers,audit:config.features.audit})};}
