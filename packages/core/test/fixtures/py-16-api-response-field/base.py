@router.get("/v1/orders/{order_id}")
async def get_order(order_id: str):
    order = await db.orders.find(order_id)
    return {"id": order.id, "total": order.total}
