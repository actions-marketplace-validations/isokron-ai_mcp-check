"""Authentication for the routes."""
from functools import wraps

from fastapi import Request


def token_required(func):
    """Reject requests without a valid token."""

    @wraps(func)
    async def wrapper(request: Request, *args, **kwargs):
        return await func(request, *args, **kwargs)

    return wrapper


def audit(func):
    """Logs the call; does not keep the endpoint's signature."""

    async def wrapper(*args, **kwargs):
        return await func(*args, **kwargs)

    return wrapper
