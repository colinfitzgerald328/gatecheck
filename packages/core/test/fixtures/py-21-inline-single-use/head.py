def quote(cart):
    subtotal = sum_cart(cart)
    total = apply_promo(subtotal) if ld_client.variation("promo-codes", ctx, False) else subtotal
    items = cart.items
    return {"total": total, "items": items}
