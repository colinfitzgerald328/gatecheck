def shipping_label(order):
    if ld_client.variation("drone-delivery", order.ctx, False) and order.drone_eligible:
        return "Drone"
    elif order.express:
        return "Express"
    else:
        return "Standard"
