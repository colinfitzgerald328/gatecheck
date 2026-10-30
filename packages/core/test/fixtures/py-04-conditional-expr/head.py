def page_size(ctx):
    return 50 if ld_client.variation("big-pages", ctx, False) else 10
