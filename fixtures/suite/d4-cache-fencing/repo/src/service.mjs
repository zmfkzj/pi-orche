export function createProfileService(client,cache){return {get:(tenant,id)=>cache.get(tenant,id,()=>client.fetchProfile(tenant,id)),invalidate:(tenant,id)=>cache.invalidate(tenant,id)};}
