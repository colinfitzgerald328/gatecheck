from .ld import ld_client


async def submit_order(order):
    if ld_client.variation("stripe-v2", order.ctx, False):
        await stripe_v2_charge(order)
    else:
        await legacy_charge(order, retry=True)
    return {"ok": True}


async def stripe_v2_charge(order):
    return await http.post("/v2/charge", json=order.dict())
