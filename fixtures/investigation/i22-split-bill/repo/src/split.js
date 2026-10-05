/** Split an amount in cents between `people` as evenly as possible. */
export function splitCents(totalCents, people) {
  if (!Number.isInteger(totalCents) || totalCents < 0) throw new Error('totalCents must be a non-negative integer');
  if (!Number.isInteger(people) || people < 1) throw new Error('people must be a positive integer');
  const share = Math.round(totalCents / people);
  return Array.from({ length: people }, () => share);
}
