import {prepareGraph,affected} from './graph.mjs';import {fingerprint} from './fingerprint.mjs';import {copy,fail} from './values.mjs';
export function createEngine({graph:input,read,compile}){
 const graph=prepareGraph(input),cache=new Map(),pending=new Map(),versions=new Map(Object.keys(graph).map(id=>[id,0]));
 function node(id,generation){const version=generation.get(id),key=JSON.stringify([id,version]),previous=cache.get(id);if(previous?.version===version)return Promise.resolve(previous);if(pending.has(key))return pending.get(key);
 const work=(async()=>{const deps=await Promise.all(graph[id].deps.map(dep=>node(dep,generation)));const source=await read(graph[id].source),hash=fingerprint(source,deps.map(d=>d.hash));let entry;if(previous?.hash===hash)entry={...previous,version};else{const dependencies=Object.fromEntries(graph[id].deps.map((dep,i)=>[dep,copy(deps[i].value)]));const value=copy(await compile({id,source,dependencies}));entry={hash,value,version};}if(versions.get(id)===version)cache.set(id,entry);return entry;})();pending.set(key,work);work.then(()=>pending.delete(key),()=>pending.delete(key));return work;
 }
 return {invalidate:id=>{for(const node of affected(graph,id))versions.set(node,versions.get(node)+1);},build:async targets=>{const ids=[...new Set(targets)];for(const id of ids)if(!Object.hasOwn(graph,id))fail('UNKNOWN_NODE');const generation=new Map(versions);const artifacts=await Promise.all(ids.map(id=>node(id,generation)));return ids.map((id,i)=>({id,value:copy(artifacts[i].value)}));}};
}
