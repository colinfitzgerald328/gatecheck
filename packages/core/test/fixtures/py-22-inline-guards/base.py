def used_twice(order):
    log(order.total)
    send(order.total)


def reassigned(order):
    return later(order.id)
