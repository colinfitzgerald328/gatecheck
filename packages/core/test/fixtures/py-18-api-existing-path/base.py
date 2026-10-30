@router.get("/v1/orders")
async def list_orders():
    return {"orders": await db.orders.all()}
