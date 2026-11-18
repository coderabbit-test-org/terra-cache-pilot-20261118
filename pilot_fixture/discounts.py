"""Small, public checkout utilities for a review launch fixture."""


def discounted_price(price, percent):
    """Compute the requested checkout value without external I/O."""
    result = price * (1 - percent / 100)
    return result
