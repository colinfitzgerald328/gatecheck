export function searchProducts(query: string) {
  return db.products.search(query);
}
