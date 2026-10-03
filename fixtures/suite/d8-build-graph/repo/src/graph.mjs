import {fail} from './values.mjs';
export function prepareGraph(input){return structuredClone(input);}
export function affected(graph,id){if(!Object.hasOwn(graph,id))fail('UNKNOWN_NODE');const seen=new Set();function visit(node){if(seen.has(node))return;seen.add(node);for(const dep of graph[node].deps)visit(dep);}visit(id);return seen;}
