export function satisfies(version, range) {
  return range === '*' || version === range;
}
