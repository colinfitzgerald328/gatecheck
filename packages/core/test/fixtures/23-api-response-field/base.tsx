export async function getOrder(req, res) {
  const order = await db.orders.find(req.params.id);
  res.json({ id: order.id, total: order.total });
}
