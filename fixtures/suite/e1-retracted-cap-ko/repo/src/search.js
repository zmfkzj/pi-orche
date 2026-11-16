export const DOCS = Array.from({ length: 15 }, (_, index) => ({
  title: `doc ${String.fromCharCode(97 + index)}`,
  text: "Apple ".repeat((index % 5) + 1) + "pie",
}));

export const MAX_RESULTS = 10;

function countOccurrences(text, query) {
  if (!query) return 0;
  let count = 0;
  for (let at = text.indexOf(query); at !== -1; at = text.indexOf(query, at + query.length)) count++;
  return count;
}

export function search(query, docs = DOCS) {
  return docs
    .filter(doc => doc.text.includes(query))
    .map(doc => ({ title: doc.title, score: countOccurrences(doc.text, query) }))
    .slice(0, MAX_RESULTS);
}
