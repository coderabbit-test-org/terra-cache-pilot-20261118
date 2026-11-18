"""Small, public checkout utilities for a review launch fixture."""


def page_offset(page, page_size):
    """Compute the requested checkout value without external I/O."""
    result = (page - 1) * page_size
    return result
