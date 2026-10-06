# src/difflib: difflib port

An ES module with the behaviour of CPython's (the `python3` on PATH) `difflib`: for every input the result must be exactly what
CPython returns (floats within 1e-12), and where CPython raises, the port throws an `Error` whose `name` is the Python exception
class. Sequences are strings or arrays of strings; Python tuples and named tuples become arrays.

- `new SequenceMatcher(a = '', b = '', { isjunk = null, autojunk = true } = {})` with `setSeqs(a, b)`, `setSeq1(a)`,
  `setSeq2(b)`, `findLongestMatch(alo, ahi, blo, bhi)` → `[i, j, size]`, `getMatchingBlocks()` → `[[i, j, size], …]`,
  `getOpcodes()` → `[[tag, i1, i2, j1, j2], …]`, `getGroupedOpcodes(n = 3)` → `[[opcode, …], …]`, `ratio()`,
  `quickRatio()`, `realQuickRatio()`. Junk heuristics (`isjunk`, the automatic popular-element junk for sequences of 200+
  items) are CPython's.
- `unifiedDiff(a, b, { fromfile = '', tofile = '', fromfiledate = '', tofiledate = '', n = 3, lineterm = '\n' } = {})` and
  `contextDiff(a, b, sameOptions)` → `string[]` (all lines, in order)
- `ndiff(a, b, { linejunk = null, charjunk = isCharacterJunk } = {})` → `string[]`, including the `? ` intraline hint lines
- `restore(delta, which)` → `string[]`
- `getCloseMatches(word, possibilities, n = 3, cutoff = 0.6)` → `string[]`
- `isCharacterJunk(ch)`, `isLineJunk(line)` → `boolean`
