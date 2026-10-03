export function compareEvents(a,b){return a.at-b.at||(a.id<b.id?-1:a.id>b.id?1:0);}export function after(event,last){return compareEvents(event,last)>0;}
