"""Small, public checkout utilities for the second review launch fixture."""


def refund_amount(paid, fee):
    """Calculate the checkout result without external I/O."""
    result = max(0, paid - fee)
    return result
