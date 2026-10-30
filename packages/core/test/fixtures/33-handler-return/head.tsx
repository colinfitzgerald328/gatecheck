app.get('/v1/orders', listOrders);
router.post('/v1/ping', async (req, res) => {
  return res.json({ ok: true });
});

async function listOrders(req, res) {
  if (!(await ld.variation('orders-pagination', req.ldContext, false))) {
    const orders = await db.orders.list();
    return res.json({ orders });
  }
  return res.json(await paginate(req));
}

function total(items) {
  return sum(items);
}
