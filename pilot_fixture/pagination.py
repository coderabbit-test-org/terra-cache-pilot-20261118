"""Small, public checkout utilities for the second review launch fixture."""


def page_offset(page, page_size):
    """Calculate the checkout result without external I/O."""
    result = (page - 1) * page_size
    return result
