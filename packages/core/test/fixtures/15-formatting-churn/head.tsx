import { Card, Button } from './ui'
import { Summary } from './Summary'
import { useFlags } from 'launchdarkly-react-client-sdk'

export function Cart({ items, }) {
  const { saveForLater } = useFlags()
  const count = (items.length)
  return <Card>
    <Summary count={count} label='Items' />
    <Button onClick={() => checkout(items,)}>
      Checkout
    </Button>
    {saveForLater && <Button onClick={() => save(items)}>Save for later</Button>}
  </Card>
}
