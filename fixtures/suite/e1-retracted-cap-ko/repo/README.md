# docsearch

In-memory document search used by the help center.

- `search(query, docs)` returns `{ title, score }` for every document whose text contains the query.
- Results are capped at 10 entries so the help-center widget stays short.
