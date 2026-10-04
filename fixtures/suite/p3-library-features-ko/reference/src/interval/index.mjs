function invalid() {
  throw Object.assign(new Error('Invalid interval set'), { code: 'INTERVAL_INPUT' });
}

/** Validate individual endpoints explicitly, including sparse array slots. */
function detachedSpan(pair) {
  if (!Array.isArray(pair) || pair.length !== 2) {
    invalid();
  }
  const start = pair[0];
  const end = pair[1];
  if (typeof start !== 'number' || typeof end !== 'number' ||
      !Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    invalid();
  }
  // Half-open zero-width spans carry no points and are removed before sorting.
  if (start === end) {
    return null;
  }
  return [start === 0 ? 0 : start, end === 0 ? 0 : end];
}


/** Normalize half-open finite bounds; touching spans form one continuous set. */
export function normalize(input) {
  if (!Array.isArray(input)) invalid();
  const spans = [];
  for (const pair of input) {
    const span = detachedSpan(pair);
    if (span) spans.push(span);
  }
  spans.sort((a,b) => a[0] - b[0] || a[1] - b[1]);
  const result = [];
  for (const [start,end] of spans) {
    const previous = result.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else result.push([start,end]);
  }
  return result;
}

export function union(a, b) {
  // Validate both operands, including an otherwise irrelevant empty set.
  return normalize([...normalize(a), ...normalize(b)]);
}

export function subtract(a, b) {
  const left = normalize(a);
  const right = normalize(b);
  const result = [];
  let j = 0;
  for (const [start,end] of left) {
    let cursor = start;
    while (j < right.length && right[j][1] <= start) j++;
    let k = j;
    while (k < right.length && right[k][0] < end) {
      const [cutStart,cutEnd] = right[k];
      if (cutStart > cursor) result.push([cursor, Math.min(cutStart,end)]);
      cursor = Math.max(cursor,cutEnd);
      if (cursor >= end) break;
      k++;
    }
    if (cursor < end) result.push([cursor,end]);
  }
  return result;
}

export function intersect(a, b) {
  const left = normalize(a);
  const right = normalize(b);
  const result = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const start = Math.max(left[i][0],right[j][0]);
    const end = Math.min(left[i][1],right[j][1]);
    if (start < end) result.push([start,end]);
    if (left[i][1] < right[j][1]) i++;
    else j++;
  }
  return result;
}
