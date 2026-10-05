export const PRICE_TTL_MS = 5 * 60 * 1000;

export function createPrices({ db, cache }) {
  return {
    async getPrice(sku) {
      const cached = await cache.get(`price:${sku}`);
      if (cached !== undefined) return cached;
      const price = await db.readPrice(sku);
      await cache.set(`price:${sku}`, price, PRICE_TTL_MS);
      return price;
    },
    async updatePrice(sku, price) {
      await db.writePrice(sku, price);
      await cache.delete(`price:${sku}`);
    },
  };
}
