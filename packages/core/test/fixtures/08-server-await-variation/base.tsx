export async function quote(req, res) {
  const price = basePrice(req.body);
  res.json({ price });
}
