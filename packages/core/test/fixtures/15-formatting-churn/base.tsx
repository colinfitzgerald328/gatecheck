import { Summary } from "./Summary";
import { Button, Card } from "./ui";

export function Cart({ items }) {
  const count = items.length;
  return (
    <Card>
      <Summary count={count} label="Items" />
      <Button onClick={() => checkout(items)}>Checkout</Button>
    </Card>
  );
}
