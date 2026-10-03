export function parseMoney(decimal,currency){return {minor:Math.round(Number(decimal)*100),currency};}
export function formatMoney(money){return (money.minor/100).toFixed(2);}
export function addMoney(a,b){return {minor:a.minor+b.minor,currency:a.currency};}
export function multiplyRatio(money,numerator,denominator){return {...money,minor:Math.round(money.minor*Number(numerator)/Number(denominator))};}
