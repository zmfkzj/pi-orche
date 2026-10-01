/** Catalog data is copied when returned so callers cannot mutate stock. */
export class Catalog {
  #products = new Map();
  constructor(products = []) {
    for (const product of products) this.add(product);
  }

  add(product) {
    if (!product.sku || this.#products.has(product.sku)) {
      throw new Error('Product SKU must be unique');
    }
    if (!Number.isFinite(product.price) || product.price < 0) {
      throw new RangeError('Invalid product price');
    }
    this.#products.set(product.sku, { ...product });
  }

  find(sku) {
    const product = this.#products.get(sku);
    if (!product) throw new Error(`Unknown product: ${sku}`);
    return { ...product };
  }

  list() {
    return [...this.#products.values()].map(product => ({ ...product }));
  }
}
