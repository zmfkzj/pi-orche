export async function* lines(chunks){for await(const chunk of chunks)for(const text of Buffer.from(chunk).toString('utf8').split('\n'))yield text;}
