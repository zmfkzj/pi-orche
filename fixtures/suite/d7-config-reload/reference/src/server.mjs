export function createServer(manager){return {handle:()=>{const config=manager.get();return {host:config.server.host,port:config.server.port,audit:config.features.audit};}};}
