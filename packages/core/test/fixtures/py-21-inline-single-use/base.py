def quote(cart):
    total = sum_cart(cart)
    return {"total": total, "items": cart.items}
