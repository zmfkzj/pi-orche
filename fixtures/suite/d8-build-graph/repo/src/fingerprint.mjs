export function fingerprint(source,dependencies){return `${source.length}:${dependencies.join(',')}`;}
