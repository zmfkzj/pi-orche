export function parseCsv(text, { delimiter = ',' } = {}) {
  if (!text) return [];
  return text.trimEnd().split('\n').map(line => line.split(delimiter));
}
