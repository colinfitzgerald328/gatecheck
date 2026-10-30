def used_twice(order):
    t = order.total
    log(t)
    send(t)


def reassigned(order):
    i = order.id
    i = normalize(i)
    return later(i)
