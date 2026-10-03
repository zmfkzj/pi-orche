import {normalizeProfile} from './values.mjs';export function createClient(transport){return {fetchProfile:async(tenant,id)=>normalizeProfile(await transport({tenant,id}))};}
