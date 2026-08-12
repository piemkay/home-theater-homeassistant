"""
The media-source interface (FR-40).

Jellyfin is the chosen implementation, not an assumption baked into the card or
the activity engine. Everything above this line talks to :class:`MediaBackend`;
swapping in a different catalogue means writing one new class.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Protocol


class SortOrder(str, Enum):
    """Sort options the card offers (FR-53)."""

    ADDED = "added"
    TITLE = "title"
    YEAR = "year"
    RATING = "rating"
    RUNTIME = "runtime"
    LAST_PLAYED = "played"
    RANDOM = "random"
    CRITICS = "critics"


class Category(str, Enum):
    """Browsable sections (FR-50)."""

    MOVIES = "movies"
    SHOWS = "shows"
    RECENT = "recent"
    CONTINUE = "continue"
    UNWATCHED = "unwatched"
    UHD = "4k"


@dataclass(frozen=True)
class MediaItem:
    """One catalogue entry, normalised away from Jellyfin's field names."""

    id: str
    title: str
    #: "movie" | "show" | "season" | "episode"
    kind: str = "movie"
    #: Series context, set on seasons and episodes (FR-50a / F2).
    series_name: str | None = None
    #: Episode number within its season, or a season's own number.
    index_number: int | None = None
    #: The season an episode belongs to.
    parent_index: int | None = None
    #: Unwatched episodes below this entry (seasons and series carry it).
    unplayed_count: int | None = None
    year: int | None = None
    runtime_minutes: int | None = None
    genres: tuple[str, ...] = ()
    countries: tuple[str, ...] = ()
    rating: float | None = None
    official_rating: str | None = None
    is_4k: bool = False
    is_3d: bool = False
    is_favorite: bool = False
    watched: bool = False
    #: 0-100, or None when there is nothing to resume.
    resume_percent: float | None = None
    resume_seconds: float | None = None
    overview: str | None = None
    tagline: str | None = None
    provider_ids: Mapping[str, str] = field(default_factory=dict)
    path: str | None = None
    image_tag: str | None = None
    backdrop_tag: str | None = None
    thumb_tag: str | None = None
    banner_tag: str | None = None
    video_format: str | None = None
    audio_format: str | None = None
    #: False when nothing playable could be matched — surfaced, never hidden
    #: (FR-47).
    playable: bool = True
    unplayable_reason: str | None = None

    @property
    def imdb_id(self) -> str | None:
        return self.provider_ids.get("Imdb")

    @property
    def tmdb_id(self) -> str | None:
        return self.provider_ids.get("Tmdb")

    @property
    def episode_code(self) -> str | None:
        """Return "S03E08" for an episode, or None."""
        if self.kind != "episode" or self.index_number is None:
            return None
        season = self.parent_index if self.parent_index is not None else 1
        return f"S{season:02d}E{self.index_number:02d}"

    @property
    def display_title(self) -> str:
        """Return the name a footer or a progress card should show.

        An episode's own title ("Der Drachenritt") says nothing without its
        series; the series plus the code is what a person recognises.
        """
        if self.kind == "episode" and self.series_name:
            code = self.episode_code
            return (
                f"{self.series_name} · {code}"
                if code
                else f"{self.series_name} · {self.title}"
            )
        return self.title

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "kind": self.kind,
            "seriesName": self.series_name,
            "indexNumber": self.index_number,
            "parentIndex": self.parent_index,
            "unplayedCount": self.unplayed_count,
            "episodeCode": self.episode_code,
            "year": self.year,
            "runtime": self.runtime_minutes,
            "genres": list(self.genres),
            "countries": list(self.countries),
            "rating": self.rating,
            "officialRating": self.official_rating,
            "res4k": self.is_4k,
            "is3d": self.is_3d,
            "favorite": self.is_favorite,
            "watched": self.watched,
            "continueWatching": self.resume_percent,
            "resumeSeconds": self.resume_seconds,
            "overview": self.overview,
            "tagline": self.tagline,
            "providerIds": dict(self.provider_ids),
            "backdropTag": self.backdrop_tag,
            "thumbTag": self.thumb_tag,
            "bannerTag": self.banner_tag,
            "videoFormat": self.video_format,
            "audioFormat": self.audio_format,
            "playable": self.playable,
            "unplayableReason": self.unplayable_reason,
        }


@dataclass(frozen=True)
class MediaQuery:
    """A combinable browse/search/filter/sort request (FR-51, FR-52, FR-53)."""

    category: Category = Category.MOVIES
    search: str | None = None
    genres: tuple[str, ...] = ()
    countries: tuple[str, ...] = ()
    year_from: int | None = None
    year_to: int | None = None
    only_4k: bool = False
    only_hd: bool = False
    only_sd: bool = False
    only_3d: bool = False
    only_unwatched: bool = False
    only_watched: bool = False
    only_resumable: bool = False
    only_favorites: bool = False
    only_recent: bool = False
    ratings: tuple[str, ...] = ()
    sort: SortOrder = SortOrder.ADDED
    #: "asc" | "desc" | None — None keeps the per-field default direction.
    sort_dir: str | None = None
    limit: int = 60
    offset: int = 0


@dataclass(frozen=True)
class MediaPage:
    """One page of results plus the total, so the card can paginate (FR-58)."""

    items: tuple[MediaItem, ...]
    total: int
    offset: int

    @property
    def has_more(self) -> bool:
        return self.offset + len(self.items) < self.total


@dataclass(frozen=True)
class Facets:
    """The filter values that actually exist in this library."""

    genres: tuple[str, ...] = ()
    countries: tuple[str, ...] = ()
    ratings: tuple[str, ...] = ()
    year_min: int | None = None
    year_max: int | None = None


class MediaBackendError(Exception):
    """A catalogue read failed. Carries a message fit to show a human."""

    def __init__(self, message: str, *, recoverable: bool = True) -> None:
        super().__init__(message)
        self.recoverable = recoverable


class MediaBackend(Protocol):
    """What the card and the activity engine need from a catalogue."""

    async def search(self, query: MediaQuery) -> MediaPage:
        """Browse, search and filter in one call."""

    async def item(self, item_id: str) -> MediaItem | None:
        """Full detail for one entry."""

    async def seasons(self, series_id: str) -> Sequence[MediaItem]:
        """Return the seasons of one series, in order (F2)."""

    async def episodes(
        self, series_id: str, season_id: str | None = None
    ) -> Sequence[MediaItem]:
        """Return the episodes of one series or one season, in order (F2)."""

    async def resume(self, limit: int = 12) -> Sequence[MediaItem]:
        """Return the resume list, sourced from the catalogue (FR-49a)."""

    async def facets(self) -> Facets:
        """Available filter values."""

    async def refresh(self) -> None:
        """Force a rescan (FR-44)."""

    async def set_favorite(self, item_id: str, favorite: bool) -> None:
        """Mark or unmark one entry as a favourite, in the catalogue."""

    async def artwork(self, item_id: str, image_type: str) -> tuple[bytes, str]:
        """Raw image bytes plus content type, for the proxy (FR-42a)."""

    async def report_start(
        self, item_id: str, *, position_seconds: float = 0.0
    ) -> None:
        """Open a playback session in the catalogue (FR-48)."""

    async def report_progress(
        self, item_id: str, *, position_seconds: float, paused: bool = False
    ) -> None:
        """Keep the session's position current (FR-49)."""

    async def report_stop(self, item_id: str, *, position_seconds: float) -> None:
        """Close the session; the catalogue derives watched state from it."""
