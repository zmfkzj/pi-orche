export const exponents={USD:2,JPY:0,KWD:3};export function exponent(currency){if(!Object.hasOwn(exponents,currency))throw new TypeError('unsupported currency');return exponents[currency];}
