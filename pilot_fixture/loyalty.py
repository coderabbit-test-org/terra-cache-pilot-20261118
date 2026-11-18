"""Small, public checkout utilities for the second review launch fixture."""


def reward_points(amount):
    """Calculate the checkout result without external I/O."""
    result = int(amount // 10)
    return result
