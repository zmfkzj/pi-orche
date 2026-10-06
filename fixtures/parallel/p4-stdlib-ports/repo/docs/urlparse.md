# src/urlparse: urllib.parse port

An ES module with the behaviour of CPython's (the `python3` on PATH) `urllib.parse` for `str` input: for every input the result
must be exactly what CPython returns, and where CPython raises, the port throws an `Error` whose `name` is the Python exception
class (`ValueError` for an invalid port, a malformed IPv6 netloc, too many query fields, …). Do not use the WHATWG `URL` class:
its rules differ.

- `urlsplit(url, scheme = '', allowFragments = true)` → `{ scheme, netloc, path, query, fragment, username, password,
  hostname, port }` (`null` where Python returns `None`; `port` is read when the result is created, so an invalid port throws
  there)
- `urlparse(url, scheme = '', allowFragments = true)` → the same plus `params`
- `urlunsplit([scheme, netloc, path, query, fragment])`, `urlunparse([scheme, netloc, path, params, query, fragment])` → `string`
- `urljoin(base, url, allowFragments = true)` → `string`; `urldefrag(url)` → `{ url, fragment }`
- `quote(s, safe = '/')`, `quotePlus(s, safe = '')`, `unquote(s)`, `unquotePlus(s)` (UTF-8, `errors='replace'`)
- `urlencode(query, { doseq = false, safe = '' } = {})`: `query` is an array of `[key, value]` pairs (with `doseq`, a value may be
  an array) or a plain object
- `parseQsl(qs, { keepBlankValues = false, strictParsing = false, maxNumFields = null, separator = '&' } = {})` → `[[key, value], …]`;
  `parseQs(qs, sameOptions)` → `{ key: [values…] }`
