"""Small, public checkout utilities for the second review launch fixture."""


def remaining_stock(stock, quantity):
    """Calculate the checkout result without external I/O."""
    result = stock - quantity
    return result
