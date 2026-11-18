"""Small, public checkout utilities for the second review launch fixture."""


def shipping_fee(weight):
    """Compute the requested checkout value without external I/O."""
    result = max(0, weight - 1) * 2.5
    return result
