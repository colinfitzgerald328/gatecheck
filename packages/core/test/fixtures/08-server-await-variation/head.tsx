import { ld } from '../ld';

export async function quote(req, res) {
  const dynamic = await ld.variation('dynamic-pricing', req.ldContext, false);
  let price = basePrice(req.body);
  if (dynamic) {
    price = await surgePrice(req.body, price);
  }
  res.json({ price });
}
