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
    FAVORITES = "favorites"
    UHD = "4k"


@dataclass(frozen=True)
class Person:
    """One cast or crew credit, normalised away from Jellyfin's field names."""

    id: str
    name: str
    #: "Actor" | "Director" | "Writer" | "Producer" | "GuestStar" | …
    kind: str = "Actor"
    #: The character (actors) or the job title (crew), when known.
    role: str | None = None
    image_tag: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "type": self.kind,
            "role": self.role,
            "imageTag": self.image_tag,
        }


@dataclass(frozen=True)
class MediaTrack:
    """One audio or subtitle stream of a title.

    A file carries several of each — three German dubs and an English
    commentary is a normal evening here — so the detail view lists them all
    rather than naming the first one and calling it "the" audio format.
    """

    #: The stream's index inside the file, as Jellyfin numbers it.
    index: int
    #: ISO-639-2 code, folded onto one spelling; None when the file says nothing.
    language: str | None = None
    codec: str | None = None
    #: "5.1", "stereo", … — audio only.
    channel_layout: str | None = None
    #: The stream's own title, when it carries one ("Director's Commentary").
    title: str | None = None
    is_default: bool = False
    is_forced: bool = False
    #: A commentary or audio-description track: present in the file, but not
    #: what "this film is available in English" should ever mean.
    is_commentary: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "language": self.language,
            "codec": self.codec,
            "channelLayout": self.channel_layout,
            "title": self.title,
            "default": self.is_default,
            "forced": self.is_forced,
            "commentary": self.is_commentary,
        }


@dataclass(frozen=True)
class Trailer:
    """A trailer the catalogue knows about, as a URL a phone can open."""

    name: str
    url: str

    def as_dict(self) -> dict[str, Any]:
        return {"name": self.name, "url": self.url}


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
    #: Rotten-Tomatoes-style critics score, 0–100 (Jellyfin's CriticRating).
    critic_rating: float | None = None
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
    #: Cast and crew, in Jellyfin's billing order. Only the single-item
    #: detail fetch carries them — grids stay light.
    people: tuple[Person, ...] = ()
    provider_ids: Mapping[str, str] = field(default_factory=dict)
    path: str | None = None
    image_tag: str | None = None
    backdrop_tag: str | None = None
    thumb_tag: str | None = None
    banner_tag: str | None = None
    video_format: str | None = None
    audio_format: str | None = None
    #: Every audio and subtitle stream of the file, in file order. Only the
    #: single-item detail fetch carries them — grids stay light.
    audio_tracks: tuple[MediaTrack, ...] = ()
    subtitle_tracks: tuple[MediaTrack, ...] = ()
    #: Trailers to watch on the phone, before the room is even on.
    trailers: tuple[Trailer, ...] = ()
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
            "criticRating": self.critic_rating,
            "officialRating": self.official_rating,
            "res4k": self.is_4k,
            "is3d": self.is_3d,
            "favorite": self.is_favorite,
            "watched": self.watched,
            "continueWatching": self.resume_percent,
            "resumeSeconds": self.resume_seconds,
            "overview": self.overview,
            "tagline": self.tagline,
            "people": [person.as_dict() for person in self.people],
            "providerIds": dict(self.provider_ids),
            "backdropTag": self.backdrop_tag,
            "thumbTag": self.thumb_tag,
            "bannerTag": self.banner_tag,
            "videoFormat": self.video_format,
            "audioFormat": self.audio_format,
            "audioTracks": [track.as_dict() for track in self.audio_tracks],
            "subtitleTracks": [track.as_dict() for track in self.subtitle_tracks],
            "trailers": [trailer.as_dict() for trailer in self.trailers],
            "playable": self.playable,
            "unplayableReason": self.unplayable_reason,
        }


@dataclass(frozen=True)
class MediaQuery:
    """A combinable browse/search/filter/sort request (FR-51, FR-52, FR-53)."""

    category: Category = Category.MOVIES
    search: str | None = None
    #: Multiple genres narrow (AND): "Action + Crime" means both, matching
    #: how a person reads stacked filter chips. Jellyfin's own parameter
    #: widens (OR), so multi-genre queries take the scan path instead.
    genres: tuple[str, ...] = ()
    countries: tuple[str, ...] = ()
    #: Catalogue person IDs (cast or crew) every result must credit.
    person_ids: tuple[str, ...] = ()
    #: ISO-639 codes; a result must carry at least one matching audio track.
    #: Commentary and audio-description tracks do not count — a film is not
    #: "available in English" because the director talks over it.
    audio_langs: tuple[str, ...] = ()
    #: ISO-639 codes; a result must carry at least one matching subtitle track.
    subtitle_langs: tuple[str, ...] = ()
    year_from: int | None = None
    year_to: int | None = None
    #: Runtime window in whole minutes, both ends inclusive. A title without
    #: a runtime is not "shorter than 90 minutes" — it falls out of any
    #: window, the way a title without a year falls out of a year range.
    runtime_from: int | None = None
    runtime_to: int | None = None
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
    #: Minimum community rating (0–10) and critics rating (0–100).
    min_rating: float | None = None
    min_critic: float | None = None
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
    #: Audio-track languages present in the library, as ISO-639 codes.
    audio_languages: tuple[str, ...] = ()
    #: Subtitle-track languages present in the library, as ISO-639 codes.
    subtitle_languages: tuple[str, ...] = ()
    year_min: int | None = None
    year_max: int | None = None
    #: Shortest and longest runtime in the library, in whole minutes — the
    #: bounds the card builds its from/to ladder between.
    runtime_min: int | None = None
    runtime_max: int | None = None


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

    async def similar(self, item_id: str, limit: int = 12) -> Sequence[MediaItem]:
        """Titles the catalogue considers similar to one entry."""

    async def persons(self, query: str, limit: int = 20) -> Sequence[Person]:
        """Cast and crew whose name matches, for the people filter."""

    async def facets(self) -> Facets:
        """Available filter values."""

    async def facet_counts(self, query: MediaQuery) -> Mapping[str, Any]:
        """Per filter value: how many titles remain if it is toggled on."""

    async def refresh(self) -> None:
        """Force a rescan (FR-44)."""

    async def set_favorite(self, item_id: str, favorite: bool) -> None:
        """Mark or unmark one entry as a favourite, in the catalogue."""

    async def set_watched(self, item_id: str, watched: bool) -> None:
        """Mark or unmark one entry as watched. Seasons cascade to episodes."""

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
