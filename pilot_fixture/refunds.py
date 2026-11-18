"""Small, public checkout utilities for the second review launch fixture."""


def refund_amount(paid, fee):
    """Compute the requested checkout value without external I/O."""
    result = max(0, paid - fee)
    return result
