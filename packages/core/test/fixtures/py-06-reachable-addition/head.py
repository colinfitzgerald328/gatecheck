def total(cart):
    return apply_discount(cart.subtotal)


def apply_discount(amount):
    return amount * 0.9
