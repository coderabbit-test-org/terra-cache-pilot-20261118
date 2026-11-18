"""Small, public checkout utilities for the second review launch fixture."""


def discounted_price(price, percent):
    """Calculate the checkout result without external I/O."""
    result = price * (1 - percent / 100)
    return result
