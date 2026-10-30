def banner(user):
    enabled = ld_client.variation("new-banner", ctx, False)
    if not enabled:
        return old_banner(user.name)
    greeting = f"Welcome back, {user.name}"
    return hero_banner(greeting)
