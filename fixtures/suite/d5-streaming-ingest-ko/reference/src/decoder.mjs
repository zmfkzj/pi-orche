// Frame bytes before decoding: this also preserves split UTF-8 code points.
export async function* lines(chunks,maxLineBytes=65536){let parts=[],length=0,overflow=false;
 function finish(){let bytes=Buffer.concat(parts,length);if(bytes.at(-1)===13)bytes=bytes.subarray(0,-1);const row={text:overflow?'':bytes.toString('utf8'),tooLong:overflow||bytes.length>maxLineBytes};parts=[];length=0;overflow=false;return row;}
 for await(const chunk of chunks){const bytes=Buffer.from(chunk);let start=0;for(let i=0;i<=bytes.length;i++){if(i===bytes.length||bytes[i]===10){const part=bytes.subarray(start,i);if(!overflow){length+=part.length;if(length>maxLineBytes+1){overflow=true;parts=[];length=0;}else parts.push(part);}if(i<bytes.length){yield finish();start=i+1;}}}}
 if(overflow||length)yield finish();
}
