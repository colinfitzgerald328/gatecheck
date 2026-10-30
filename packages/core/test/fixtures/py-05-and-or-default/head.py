def page_size(ctx):
    limit = (ld_client.variation("big-pages", ctx, False) and 50) or 10
    return limit
