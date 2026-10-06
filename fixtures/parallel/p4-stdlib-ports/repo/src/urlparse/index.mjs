// Port of CPython's urllib.parse. Spec: docs/urlparse.md.
const todo = name => () => { throw new Error(`urlparse.${name} is not implemented yet`); };
export const urlsplit = todo('urlsplit');
export const urlunsplit = todo('urlunsplit');
export const urlparse = todo('urlparse');
export const urlunparse = todo('urlunparse');
export const urljoin = todo('urljoin');
export const urldefrag = todo('urldefrag');
export const quote = todo('quote');
export const quotePlus = todo('quotePlus');
export const unquote = todo('unquote');
export const unquotePlus = todo('unquotePlus');
export const urlencode = todo('urlencode');
export const parseQsl = todo('parseQsl');
export const parseQs = todo('parseQs');
