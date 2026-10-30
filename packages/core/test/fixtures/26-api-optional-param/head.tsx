export function searchProducts(query: string, opts?: { limit: number }) {
  return db.products.search(query);
}
