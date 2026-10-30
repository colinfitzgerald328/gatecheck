def shipping_label(order):
    if order.express:
        return "Express"
    else:
        return "Standard"
