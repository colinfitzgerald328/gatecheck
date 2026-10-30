def search_products(query: str, limit: int = 20):
    return db.products.search(query)
