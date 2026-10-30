def can_refund(user, order):
    if user.is_admin:
        return True
    return order.age_days < 30
