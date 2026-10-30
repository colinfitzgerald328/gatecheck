import { app } from './app';

app.get('/v1/orders', listOrders);
app.get('/v2/orders', listOrdersV2);

function listOrders(req, res) {
  res.json(db.orders.all());
}

function listOrdersV2(req, res) {
  res.json({ data: db.orders.all(), cursor: paginate(req) });
}

function paginate(req) {
  return req.query.cursor ?? null;
}
