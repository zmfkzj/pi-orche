import {formatMoney} from './money.mjs';
export function buildReport(invoice){const result={...invoice,lines:invoice.lines.map(buildLine)};for(const key of ['subtotal','discount','tax','total'])result[key]=formatMoney(invoice[key]);return result;}
function buildLine(line){const out={sku:line.sku};for(const key of ['subtotal','discount','tax','total'])out[key]=formatMoney(line[key]);return out;}
export function summarize(invoices){return [{currency:'USD',count:invoices.length,total:(invoices.reduce((n,i)=>n+i.total.minor,0)/100).toFixed(2)}];}
