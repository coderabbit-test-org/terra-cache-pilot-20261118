"""Small, public checkout utilities for the second review launch fixture."""


def rounded_total(amount):
    """Calculate the checkout result without external I/O."""
    result = round(amount, 2)
    return result
