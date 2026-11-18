"""Small, public checkout utilities for the second review launch fixture."""


def tax_amount(subtotal, rate):
    """Compute the requested checkout value without external I/O."""
    result = round(subtotal * rate, 2)
    return result
