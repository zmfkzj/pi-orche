# src/text: textwrap and shlex ports

Two ES modules with the behaviour of CPython's (the `python3` on PATH) `textwrap` and `shlex`: for every input the result must be
exactly what CPython returns, and where CPython raises, the port throws an `Error` whose `name` is the Python exception class
(`ValueError`, `TypeError`, …).

## src/text/textwrap.mjs

- `wrap(text, options = {})` → `string[]`, `fill(text, options = {})` → `string`
- `shorten(text, width, options = {})` → `string`
- `dedent(text)` → `string`, `indent(text, prefix, predicate = undefined)` → `string`

`options` are `TextWrapper`'s keyword arguments in camelCase, with the same defaults: `width` (70), `initialIndent` (''),
`subsequentIndent` (''), `expandTabs` (true), `tabsize` (8), `replaceWhitespace` (true), `fixSentenceEndings` (false),
`breakLongWords` (true), `dropWhitespace` (true), `breakOnHyphens` (true), `maxLines` (null), `placeholder` (' [...]').
Text may contain any Unicode; Python's notion of whitespace and word characters applies (`str.isspace`, the `re` patterns of
`TextWrapper`).

## src/text/shlex.mjs

- `split(s, { comments = false, posix = true } = {})` → `string[]` (CPython `shlex.split`, including non-POSIX mode and its
  `ValueError`s for unclosed quotes and trailing escapes)
- `quote(s)` → `string`, `join(parts)` → `string`
