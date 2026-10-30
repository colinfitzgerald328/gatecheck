app.get('/v1/orders', listOrders);
router.post('/v1/ping', async (req, res) => {
  res.json({ ok: true });
});

async function listOrders(req, res) {
  const orders = await db.orders.list();
  res.json({ orders });
}

function total(items) {
  sum(items);
}
