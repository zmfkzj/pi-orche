export function createServer(manager){const config=manager.get();return {handle:()=>({host:config.server.host,port:config.server.port,audit:config.features.audit})};}
