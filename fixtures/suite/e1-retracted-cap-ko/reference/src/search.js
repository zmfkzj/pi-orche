export const DOCS = Array.from({ length: 15 }, (_, index) => ({
  title: `doc ${String.fromCharCode(97 + index)}`,
  text: "Apple ".repeat((index % 5) + 1) + "pie",
}));

function countOccurrences(text, query) {
  if (!query) return 0;
  let count = 0;
  for (let at = text.indexOf(query); at !== -1; at = text.indexOf(query, at + query.length)) count++;
  return count;
}

export function search(query, docs = DOCS) {
  const needle = String(query).toLowerCase();
  return docs
    .map(doc => ({ title: doc.title, score: countOccurrences(doc.text.toLowerCase(), needle) }))
    .filter(result => result.score > 0)
    .sort((a, b) => b.score - a.score || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
}
