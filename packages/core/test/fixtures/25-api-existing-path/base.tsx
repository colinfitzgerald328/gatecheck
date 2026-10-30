import { app } from './app';

app.get('/v1/orders', listOrders);

function listOrders(req, res) {
  res.json(db.orders.all());
}
