def checkout_total(cart):
    return sum(item.price * item.qty for item in cart.items)
