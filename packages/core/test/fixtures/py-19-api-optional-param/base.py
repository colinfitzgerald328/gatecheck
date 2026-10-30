def search_products(query: str):
    return db.products.search(query)
