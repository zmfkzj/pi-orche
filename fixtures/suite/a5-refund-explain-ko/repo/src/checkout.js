import { Cart } from './cart.js';

export function checkout(catalog, selections, region = 'US') {
  const cart = new Cart();
  for (const selection of selections) {
    const product = catalog.find(selection.sku);
    cart.add(product.sku, product.price, selection.quantity);
  }
  if (!cart.lines.length) throw new Error('Cannot checkout an emtpy cart');
  return cart.totals(region);
}
