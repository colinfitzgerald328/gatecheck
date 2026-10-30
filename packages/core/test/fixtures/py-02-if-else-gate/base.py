async def submit_order(order):
    await legacy_charge(order)
    return {"ok": True}
