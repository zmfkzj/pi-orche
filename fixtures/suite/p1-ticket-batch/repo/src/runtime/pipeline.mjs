export async function* mapValues(source, mapper) {
  let index = 0;
  for await (const item of source) yield await mapper(item, index++);
}
export async function* filterValues(source, predicate) {
  let index = 0;
  for await (const item of source) {
    if (await predicate(item, index++)) yield item;
  }
}
export async function* batches(source, size) {
  if (!Number.isSafeInteger(size) || size < 1) throw new RangeError('Invalid batch size');
  let batch = [];
  for await (const item of source) {
    batch.push(item);
    if (batch.length === size) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length) yield batch;
}
export async function reduceValues(source, reducer, initial) {
  let result = initial;
  let index = 0;
  for await (const item of source) result = await reducer(result, item, index++);
  return result;
}
/** Bounded worker pool. Result order follows source order, not completion order. */
export async function mapConcurrent(items, concurrency, mapper) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new RangeError('Invalid concurrency');
  const results = new Array(items.length);
  let cursor = 0;
  let failed = false;
  async function worker() {
    while (!failed && cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, worker));
  return results;
}
export async function collectValues(source) {
  const result = [];
  for await (const item of source) result.push(item);
  return result;
}
export async function* takeValues(source, limit) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('Invalid limit');
  if (!limit) return;
  let count = 0;
  for await (const item of source) {
    yield item;
    if (++count >= limit) break;
  }
}
export function composePipeline(...stages) {
  return source => stages.reduce((current, stage) => stage(current), source);
}
