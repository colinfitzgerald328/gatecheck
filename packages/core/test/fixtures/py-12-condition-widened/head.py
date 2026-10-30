def can_refund(user, order):
    if ld_client.variation("self-serve-refunds", ctx, False) and order.total < 100:
        return True
    if user.is_admin or user.is_support:
        return True
    return order.age_days < 30
