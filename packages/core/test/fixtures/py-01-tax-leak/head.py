import ldclient


def checkout_total(cart):
    total = sum(item.price * item.qty for item in cart.items) + cart.tax
    if ldclient.get().variation("express-checkout", ctx, False):
        total += express_fee(cart)
    return total


def express_fee(cart):
    return 4.99
