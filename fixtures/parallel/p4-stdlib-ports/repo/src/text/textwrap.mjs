// Port of CPython's textwrap module. Spec: docs/text.md.
const todo = name => () => { throw new Error(`textwrap.${name} is not implemented yet`); };
export const wrap = todo('wrap');
export const fill = todo('fill');
export const shorten = todo('shorten');
export const dedent = todo('dedent');
export const indent = todo('indent');
