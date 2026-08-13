"""Media catalogue backends."""

from __future__ import annotations

from .base import (
    Category,
    Facets,
    MediaBackend,
    MediaBackendError,
    MediaItem,
    MediaPage,
    MediaQuery,
    MediaTrack,
    Person,
    SortOrder,
    Trailer,
)
from .jellyfin import JellyfinAuthError, JellyfinClient

__all__ = [
    "Category",
    "Facets",
    "JellyfinAuthError",
    "JellyfinClient",
    "MediaBackend",
    "MediaBackendError",
    "MediaItem",
    "MediaPage",
    "MediaQuery",
    "MediaTrack",
    "Person",
    "SortOrder",
    "Trailer",
]
