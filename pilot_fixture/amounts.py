"""Small, public checkout utilities for the second review launch fixture."""


def total_amount(prices):
    """Compute the requested checkout value without external I/O."""
    result = sum(prices)
    return result
