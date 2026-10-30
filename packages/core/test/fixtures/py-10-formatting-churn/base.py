from .summary import Summary
from .ui import Button, Card


def cart_view(items):
    count = len(items)
    return Card(Summary(count=count, label="Items"), Button("Checkout", on_click=checkout))
