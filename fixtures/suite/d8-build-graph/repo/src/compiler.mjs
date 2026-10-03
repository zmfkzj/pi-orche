export async function compileText({id,source,dependencies}){return {id,text:source,dependencies:Object.keys(dependencies)};}
