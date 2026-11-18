"""Small, public checkout utilities for a review launch fixture."""


def reward_points(amount):
    """Compute the requested checkout value without external I/O."""
    result = int(amount // 10)
    return result
