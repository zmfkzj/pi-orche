# minihttp API

The service returns JSON with content-type application/json; charset=utf-8, except static assets and empty delete responses. Errors use {"error":"message"}. Items have string id, string name, and nonnegative integer quantity. Storage is in-memory and scoped to an application; creation order determines list order. JSON request bodies have a 65536-byte maximum: malformed or empty JSON returns 400; oversized bodies return 413. Unknown routes return 404. Unexpected failures return 500.

## GET /health
No parameters. 200: {"status":"ok"}.

## GET /items
Query page defaults to 1 and limit defaults to 10. Both must be integers: page >= 1, 1 <= limit <= 100. Invalid pagination returns 400. 200: {"items":[{"id":"1","name":"pen","quantity":4}],"total":1,"page":1,"limit":10}. Pages are one-based in insertion order, may be partial, and beyond the collection return an empty items array with the same total.

## GET /items/:id
Path id is percent-decoded and identifies an item. 200 returns the full item. Unknown id returns 404.

## POST /items
Body is a JSON object with exactly name and quantity: name must be a nonblank string (trimmed before storing); quantity must be a nonnegative integer. Null, arrays, missing or unknown fields and invalid values return 400. Duplicate trimmed names return 409. 201 returns the new full item with a generated string id. Invalid or conflicting writes do not change storage.

## DELETE /items/:id
Path id is percent-decoded. 204 has an empty body after deletion. Unknown id returns 404.

## GET /static/<path>
Path is decoded once and resolved under the configured publicDir (defaults to public/ relative to the working directory). Nested files and percent-encoded filenames are supported. Query strings do not affect file selection. Successful reads return 200 and raw file bytes; .html is text/html, .txt text/plain, .css text/css, and other extensions application/octet-stream. Invalid percent encoding returns 400, escaping the public directory returns 403, and missing/unreadable files return 404. Only GET is supported; other methods do not serve assets and return route-not-found 404 (write requests are still subject to JSON parsing). There is no PATCH endpoint.
