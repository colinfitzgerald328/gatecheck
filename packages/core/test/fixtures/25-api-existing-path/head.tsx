import { app } from './app';

app.get('/v1/orders', listOrdersFast);
app.get('/v1/orders', listOrders);

function listOrders(req, res) {
  res.json(db.orders.all());
}

function listOrdersFast(req, res) {
  res.json(cache.orders());
}
