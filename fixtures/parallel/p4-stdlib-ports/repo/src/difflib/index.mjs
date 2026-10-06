// Port of CPython's difflib. Spec: docs/difflib.md.
const todo = name => () => { throw new Error(`difflib.${name} is not implemented yet`); };
export class SequenceMatcher {
  constructor() { throw new Error('difflib.SequenceMatcher is not implemented yet'); }
}
export const unifiedDiff = todo('unifiedDiff');
export const contextDiff = todo('contextDiff');
export const ndiff = todo('ndiff');
export const restore = todo('restore');
export const getCloseMatches = todo('getCloseMatches');
export const isCharacterJunk = todo('isCharacterJunk');
export const isLineJunk = todo('isLineJunk');
