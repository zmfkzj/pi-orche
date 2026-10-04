export function normalize(intervals) { return intervals.map(pair => [...pair]); }
export function union(a, b) { return [...normalize(a), ...normalize(b)]; }
export function subtract(a) { return normalize(a); }
export function intersect() { return []; }
