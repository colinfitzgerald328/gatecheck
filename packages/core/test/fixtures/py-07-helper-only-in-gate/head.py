def total(cart):
    if ld_client.variation("loyalty-discount", ctx, False):
        return apply_discount(cart.subtotal)
    return cart.subtotal


def apply_discount(amount):
    return amount * 0.9
