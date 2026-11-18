"""Small, public checkout utilities for a review launch fixture."""


def rounded_total(amount):
    """Compute the requested checkout value without external I/O."""
    result = round(amount, 2)
    return result
