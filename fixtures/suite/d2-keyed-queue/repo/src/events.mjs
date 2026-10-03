export function emit(listener,type,key){try{listener?.({type,key});}catch{ /* Observer failure must not alter work. */ }}
