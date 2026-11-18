"""Small, public checkout utilities for the second review launch fixture."""


def total_amount(prices):
    """Calculate the checkout result without external I/O."""
    result = sum(prices)
    return result
