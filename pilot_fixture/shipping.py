"""Small, public checkout utilities for the second review launch fixture."""


def shipping_fee(weight):
    """Calculate the checkout result without external I/O."""
    result = max(0, weight - 1) * 2.5
    return result
