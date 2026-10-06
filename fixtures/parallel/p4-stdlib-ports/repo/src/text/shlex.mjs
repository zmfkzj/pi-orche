// Port of CPython's shlex.split/quote/join. Spec: docs/text.md.
const todo = name => () => { throw new Error(`shlex.${name} is not implemented yet`); };
export const split = todo('split');
export const quote = todo('quote');
export const join = todo('join');
