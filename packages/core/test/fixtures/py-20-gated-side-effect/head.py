def on_add_to_cart(item):
    ld_client.variation("cart-analytics", ctx, False) and analytics.track("add_to_cart", sku=item.sku)
    cart.add(item)
