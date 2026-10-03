import {exponent} from './currencies.mjs';
export function encodeMoney(money){exponent(money.currency);if(typeof money.minor!=='bigint')throw new TypeError('minor');return {minor:money.minor.toString(),currency:money.currency};}
export function decodeMoney(value){if(!value||typeof value.minor!=='string'||!/^[-+]?\d+$/.test(value.minor))throw new TypeError('minor');exponent(value.currency);return {minor:BigInt(value.minor),currency:value.currency};}
