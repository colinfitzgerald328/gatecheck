from .ui import Button, Card
from .summary import Summary


def cart_view(items):
    count = (len(items))
    save = ld_client.variation('save-for-later', ctx, False)
    return Card(
        Summary(count=count, label='Items'),
        Button('Checkout', on_click=checkout),
    ) if not save else Card(Summary(count=count, label='Items'), Button('Save', on_click=save_items))
