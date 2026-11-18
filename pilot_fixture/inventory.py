"""Small, public checkout utilities for a review launch fixture."""


def remaining_stock(stock, quantity):
    """Compute the requested checkout value without external I/O."""
    result = stock - quantity
    return result
