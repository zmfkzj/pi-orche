export function createClock(initial=0){let now=initial;return {now:()=>now,advance:delta=>now+=delta};}
