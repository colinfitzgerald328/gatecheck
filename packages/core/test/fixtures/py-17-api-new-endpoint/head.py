@router.get("/v1/orders")
async def list_orders():
    return {"orders": await db.orders.all()}


@router.get("/v2/orders")
async def list_orders_v2(cursor: str | None = None):
    page = await db.orders.page(cursor=parse_cursor(cursor))
    return {"data": page.items, "cursor": page.next}


def parse_cursor(cursor):
    return cursor or None
