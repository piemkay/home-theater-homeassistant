"""
Jellyfin API client.

Deliberately independent of the official `jellyfin` integration (FR-39z): that
integration's media source cannot search (`can_search: false` on every node) and
its content IDs address Jellyfin playback, whereas playback here goes to the
Zidoo. The two coexist; neither is load-bearing for the other.

Authentication uses a **user access token**, not a bare API key. Play-state
reporting (`/Sessions/Playing*`) is session-scoped and an API key alone does not
produce a session Jellystat will sample (FR-49d). The token is obtained through
QuickConnect, which was verified enabled on this server — so setup never handles
a password.
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote

from .base import (
    Category,
    Facets,
    MediaBackendError,
    MediaItem,
    MediaPage,
    MediaQuery,
    SortOrder,
)

_LOGGER = logging.getLogger(__name__)

CLIENT_NAME = "Kino"
CLIENT_VERSION = "0.1.0"
DEVICE_NAME = "Kino – Zidoo"

_MOVIE_FIELDS = ",".join(  # noqa: FLY002 - a long, readable field list
    (
        "ProviderIds",
        "Path",
        "Overview",
        "Taglines",
        "Genres",
        "ProductionLocations",
        "MediaSources",
        "MediaStreams",
        "CommunityRating",
        "UserData",
        "RunTimeTicks",
        "ProductionYear",
        "PremiereDate",
        "DateCreated",
    )
)

#: Random re-randomises on every request, so paginated pages can repeat or
#: skip titles — accepted; the card's grid stays usable and a refresh reshuffles.
_SORT_FIELDS: dict[SortOrder, tuple[str, str]] = {
    SortOrder.ADDED: ("DateCreated", "Descending"),
    SortOrder.TITLE: ("SortName", "Ascending"),
    SortOrder.YEAR: ("ProductionYear", "Descending"),
    SortOrder.RATING: ("CommunityRating", "Descending"),
    SortOrder.RUNTIME: ("Runtime", "Descending"),
    SortOrder.LAST_PLAYED: ("DatePlayed", "Descending"),
    SortOrder.RANDOM: ("Random", "Ascending"),
    SortOrder.CRITICS: ("CriticRating", "Descending"),
}

#: 1 tick = 100 ns.
TICKS_PER_SECOND = 10_000_000


class JellyfinAuthError(MediaBackendError):
    """The token was rejected. Setup has to be redone."""


class JellyfinClient:
    """Thin async client over the endpoints Kino actually uses."""

    def __init__(
        self,
        session: Any,
        *,
        base_url: str,
        token: str | None = None,
        user_id: str | None = None,
        device_id: str = "kino",
        timeout: float = 15.0,
    ) -> None:
        self._session = session
        self._base = base_url.rstrip("/")
        self._token = token
        self._user_id = user_id
        self._device_id = device_id
        self._timeout = timeout

    @property
    def user_id(self) -> str | None:
        return self._user_id

    @property
    def base_url(self) -> str:
        return self._base

    def authorization_header(self) -> str:
        parts = [
            f'Client="{CLIENT_NAME}"',
            f'Device="{DEVICE_NAME}"',
            f'DeviceId="{self._device_id}"',
            f'Version="{CLIENT_VERSION}"',
        ]
        if self._token:
            parts.insert(0, f'Token="{self._token}"')
        return f"MediaBrowser {', '.join(parts)}"

    # -- transport ----------------------------------------------------------

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: Mapping[str, Any] | None = None,
        json: Mapping[str, Any] | None = None,
        raw: bool = False,
    ) -> Any:
        url = f"{self._base}/{path.lstrip('/')}"
        headers = {"Authorization": self.authorization_header()}
        clean = (
            {k: _param(v) for k, v in params.items() if v is not None}
            if params
            else None
        )
        try:
            response = await self._session.request(
                method,
                url,
                params=clean,
                json=json,
                headers=headers,
                timeout=self._timeout,
            )
        except (TimeoutError, asyncio.TimeoutError) as err:  # noqa: UP041 - two distinct classes on Python 3.10, which CI still runs
            raise MediaBackendError(
                "Die Bibliothek antwortet nicht. Bitte erneut versuchen."
            ) from err
        except Exception as err:
            raise MediaBackendError(
                f"Die Bibliothek ist nicht erreichbar ({err})."
            ) from err

        async with response:
            if response.status in (401, 403):
                raise JellyfinAuthError(
                    "Jellyfin hat die Anmeldung abgelehnt. "
                    "Bitte die Kino-Integration neu verbinden.",
                    recoverable=False,
                )
            if response.status == 404:
                return None
            if response.status >= 400:
                raise MediaBackendError(f"Jellyfin meldet Fehler {response.status}.")
            if raw:
                return (
                    await response.read(),
                    response.headers.get("Content-Type", "image/jpeg"),
                )
            if response.status == 204:
                return None
            return await response.json()

    # -- QuickConnect (setup) ----------------------------------------------

    async def quick_connect_initiate(self) -> dict[str, Any]:
        """Start a QuickConnect request; the user approves it in Jellyfin."""
        result = await self._request("POST", "/QuickConnect/Initiate")
        if not result:
            raise MediaBackendError(
                "QuickConnect ist auf diesem Jellyfin-Server nicht aktiviert."
            )
        return result

    async def quick_connect_poll(self, secret: str) -> bool:
        result = await self._request(
            "GET", "/QuickConnect/Connect", params={"secret": secret}
        )
        return bool(result and result.get("Authenticated"))

    async def quick_connect_authenticate(self, secret: str) -> dict[str, Any]:
        """Exchange an approved QuickConnect secret for a user token."""
        result = await self._request(
            "POST",
            "/Users/AuthenticateWithQuickConnect",
            json={"Secret": secret},
        )
        if not result or "AccessToken" not in result:
            raise JellyfinAuthError(
                "QuickConnect wurde noch nicht bestätigt.", recoverable=True
            )
        self._token = result["AccessToken"]
        self._user_id = (result.get("User") or {}).get("Id")
        return result

    async def system_info(self) -> dict[str, Any]:
        return await self._request("GET", "/System/Info/Public") or {}

    # -- catalogue ----------------------------------------------------------

    def _require_user(self) -> str:
        if not self._user_id:
            raise JellyfinAuthError(
                "Kein Jellyfin-Benutzer verbunden.", recoverable=False
            )
        return self._user_id

    async def search(self, query: MediaQuery) -> MediaPage:
        user = self._require_user()
        params = _search_params(query)
        payload = await self._request("GET", f"/Users/{user}/Items", params=params)
        raw_items = (payload or {}).get("Items") or []
        total = int((payload or {}).get("TotalRecordCount", len(raw_items)))

        items = [_to_item(raw) for raw in raw_items]
        items = _apply_client_side_filters(items, query)
        return MediaPage(items=tuple(items), total=total, offset=query.offset)

    async def item(self, item_id: str) -> MediaItem | None:
        user = self._require_user()
        payload = await self._request(
            "GET",
            f"/Users/{user}/Items/{quote(item_id)}",
            params={"Fields": _MOVIE_FIELDS},
        )
        return _to_item(payload) if payload else None

    async def seasons(self, series_id: str) -> Sequence[MediaItem]:
        """Return the seasons of one series, in broadcast order (F2)."""
        user = self._require_user()
        payload = await self._request(
            "GET",
            f"/Shows/{quote(series_id)}/Seasons",
            params={"UserId": user, "Fields": _MOVIE_FIELDS},
        )
        return [_to_item(raw) for raw in (payload or {}).get("Items") or []]

    async def episodes(
        self, series_id: str, season_id: str | None = None
    ) -> Sequence[MediaItem]:
        """Return the episodes of one series or one season, in order (F2)."""
        user = self._require_user()
        payload = await self._request(
            "GET",
            f"/Shows/{quote(series_id)}/Episodes",
            params={
                "UserId": user,
                "SeasonId": season_id,
                "Fields": _MOVIE_FIELDS,
            },
        )
        return [_to_item(raw) for raw in (payload or {}).get("Items") or []]

    async def resume(self, limit: int = 12) -> Sequence[MediaItem]:
        user = self._require_user()
        payload = await self._request(
            "GET",
            f"/Users/{user}/Items/Resume",
            params={
                "Limit": limit,
                "Fields": _MOVIE_FIELDS,
                "MediaTypes": "Video",
            },
        )
        return [_to_item(raw) for raw in (payload or {}).get("Items") or []]

    async def facets(self) -> Facets:
        # The legacy filter endpoint carries genres, official ratings and the
        # year bounds in one round trip. If a future Jellyfin drops it, the
        # replacement is `/Items/Filters2` (different shape: NameGuidPair
        # lists instead of plain strings).
        user = self._require_user()
        payload = await self._request(
            "GET",
            "/Items/Filters",
            params={
                "UserId": user,
                "IncludeItemTypes": "Movie,Series",
                "Recursive": True,
            },
        )
        payload = payload or {}
        genres = tuple(
            sorted((g for g in payload.get("Genres") or [] if g), key=str.casefold)
        )
        # Jellyfin returns ratings alphabetically ("FSK-18" before "FSK-6").
        # Sort by system first, then by rank within it (F12).
        ratings = tuple(
            sorted(
                (r for r in payload.get("OfficialRatings") or [] if r),
                key=_rating_sort_key,
            )
        )
        years = [y for y in payload.get("Years") or [] if isinstance(y, int)]
        return Facets(
            genres=genres,
            ratings=ratings,
            year_min=min(years) if years else None,
            year_max=max(years) if years else None,
        )

    async def refresh(self) -> None:
        """Ask Jellyfin to rescan (FR-44)."""
        await self._request("POST", "/Library/Refresh")

    async def set_favorite(self, item_id: str, favorite: bool) -> None:
        """Mark or unmark a favourite for the connected user."""
        user = self._require_user()
        method = "POST" if favorite else "DELETE"
        await self._request(method, f"/Users/{user}/FavoriteItems/{quote(item_id)}")

    async def artwork(
        self, item_id: str, image_type: str = "Primary"
    ) -> tuple[bytes, str]:
        result = await self._request(
            "GET",
            f"/Items/{quote(item_id)}/Images/{quote(image_type)}",
            params={"maxWidth": 480 if image_type == "Primary" else 1280},
            raw=True,
        )
        if result is None:
            raise MediaBackendError("Kein Bild vorhanden.")
        return result

    # -- play-state reporting (FR-48, FR-49) --------------------------------

    async def report_start(
        self, item_id: str, *, position_seconds: float = 0.0
    ) -> None:
        await self._request(
            "POST",
            "/Sessions/Playing",
            json={
                "ItemId": item_id,
                "PositionTicks": int(position_seconds * TICKS_PER_SECOND),
                "CanSeek": True,
                "IsPaused": False,
                "PlayMethod": "DirectPlay",
            },
        )

    async def report_progress(
        self, item_id: str, *, position_seconds: float, paused: bool = False
    ) -> None:
        await self._request(
            "POST",
            "/Sessions/Playing/Progress",
            json={
                "ItemId": item_id,
                "PositionTicks": int(position_seconds * TICKS_PER_SECOND),
                "IsPaused": paused,
                "PlayMethod": "DirectPlay",
                "EventName": "timeupdate",
            },
        )

    async def report_stop(self, item_id: str, *, position_seconds: float) -> None:
        await self._request(
            "POST",
            "/Sessions/Playing/Stopped",
            json={
                "ItemId": item_id,
                "PositionTicks": int(position_seconds * TICKS_PER_SECOND),
            },
        )


# --------------------------------------------------------------------------
# Normalisation
# --------------------------------------------------------------------------


def _param(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


#: Rank tables for rating systems that carry no number of their own.
_MPAA_ORDER = {"G": 0, "PG": 1, "PG-13": 2, "R": 3, "NC-17": 4, "NR": 5}
_TV_ORDER = {"TV-Y": 0, "TV-Y7": 1, "TV-G": 2, "TV-PG": 3, "TV-14": 4, "TV-MA": 5}


def _rating_sort_key(rating: str) -> tuple[int, int, str]:
    """Order age ratings by system, then by rank within it (F12).

    FSK first — this is a German house — then MPAA, then TV, then anything
    else that carries a number, then the rest alphabetically.
    """
    value = rating.strip()
    fsk = re.match(r"(?i)^FSK[- ]?(\d+)$", value)
    if fsk:
        return (0, int(fsk.group(1)), value)
    if value in _MPAA_ORDER:
        return (1, _MPAA_ORDER[value], value)
    if value in _TV_ORDER:
        return (2, _TV_ORDER[value], value)
    numbered = re.search(r"(\d+)", value)
    if numbered:
        return (3, int(numbered.group(1)), value)
    return (4, 0, value)


def _search_params(  # noqa: C901, PLR0912 - a flat translation table, one branch per filter
    query: MediaQuery,
) -> dict[str, Any]:
    """Translate one :class:`MediaQuery` into `/Items` query parameters."""
    sort_by, sort_order = _SORT_FIELDS[query.sort]
    # The home rows (recent, continue) should show both kinds.
    if query.category is Category.SHOWS:
        item_types = "Series"
    elif query.category in (Category.RECENT, Category.CONTINUE):
        item_types = "Movie,Series"
    else:
        item_types = "Movie"
    params: dict[str, Any] = {
        "Recursive": True,
        "Fields": _MOVIE_FIELDS,
        "IncludeItemTypes": item_types,
        "SortBy": sort_by,
        "SortOrder": sort_order,
        "Limit": query.limit,
        "StartIndex": query.offset,
        "EnableTotalRecordCount": True,
    }
    if query.search:
        params["SearchTerm"] = query.search
    if query.genres:
        params["Genres"] = "|".join(query.genres)
    # Countries have no server-side parameter; they are applied client-side
    # in `_apply_client_side_filters` rather than pretended away here.
    #
    # Resolution goes server-side (`is_4k` is width >= 3000): a client-side
    # cut after pagination made page sizes lie and the card's next offset —
    # computed from what it kept — skip or repeat titles. The three tiers are
    # a single-select in the card; Jellyfin cannot OR width windows.
    if query.only_4k or query.category is Category.UHD:
        params["MinWidth"] = 3000
    if query.only_hd:
        params["MinWidth"] = 1280
        params["MaxWidth"] = 2999
    if query.only_sd:
        params["MaxWidth"] = 1279
    if query.only_3d:
        params["Is3D"] = True
    if query.ratings:
        params["OfficialRatings"] = "|".join(query.ratings)
    years = _year_range(query.year_from, query.year_to)
    if years:
        params["Years"] = ",".join(str(y) for y in years)
    # Filters combine — assigning would let the last one silently win.
    filters = []
    if query.only_unwatched or query.category is Category.UNWATCHED:
        filters.append("IsUnplayed")
    if query.only_watched:
        filters.append("IsPlayed")
    if query.only_resumable or query.category is Category.CONTINUE:
        filters.append("IsResumable")
    if query.only_favorites:
        filters.append("IsFavorite")
    if filters:
        params["Filters"] = ",".join(filters)
    if query.category is Category.RECENT or query.only_recent:
        params["SortBy"] = "DateCreated"
        params["SortOrder"] = "Descending"
    # The explicit direction wins everywhere, including the recent override.
    if query.sort_dir:
        params["SortOrder"] = "Ascending" if query.sort_dir == "asc" else "Descending"
    return params


def _year_range(start: int | None, end: int | None) -> list[int]:
    """`Years` wants an explicit list; open ends get sensible defaults."""
    if start is None and end is None:
        return []
    low = start if start is not None else 1900
    high = end if end is not None else datetime.now(tz=timezone.utc).year
    if high < low or high - low > 150:
        return []
    return list(range(low, high + 1))


def _to_item(raw: Mapping[str, Any]) -> MediaItem:
    user_data = raw.get("UserData") or {}
    runtime_ticks = raw.get("RunTimeTicks")
    runtime = int(runtime_ticks / TICKS_PER_SECOND / 60) if runtime_ticks else None

    resume_ticks = user_data.get("PlaybackPositionTicks") or 0
    resume_seconds = resume_ticks / TICKS_PER_SECOND if resume_ticks else None
    resume_percent = user_data.get("PlayedPercentage")
    if resume_percent is None and resume_seconds and runtime_ticks:
        resume_percent = resume_ticks / runtime_ticks * 100.0

    width, video_format, audio_format = _stream_summary(raw)
    provider_ids = {str(k): str(v) for k, v in (raw.get("ProviderIds") or {}).items()}
    path = raw.get("Path")

    # FR-46/FR-47: an entry the card offers must actually play. Provider ID
    # first because it survives a mount-point change; path is the fallback.
    playable = bool(provider_ids.get("Tmdb") or provider_ids.get("Imdb") or path)
    taglines = raw.get("Taglines") or []
    kind = {"Series": "show", "Season": "season", "Episode": "episode"}.get(
        str(raw.get("Type")), "movie"
    )
    unplayed = user_data.get("UnplayedItemCount")

    return MediaItem(
        id=str(raw.get("Id", "")),
        title=str(raw.get("Name") or "Ohne Titel"),
        kind=kind,
        series_name=raw.get("SeriesName"),
        index_number=raw.get("IndexNumber"),
        parent_index=raw.get("ParentIndexNumber"),
        unplayed_count=int(unplayed) if isinstance(unplayed, int) else None,
        year=raw.get("ProductionYear"),
        runtime_minutes=runtime,
        genres=tuple(raw.get("Genres") or ()),
        countries=tuple(raw.get("ProductionLocations") or ()),
        rating=raw.get("CommunityRating"),
        official_rating=raw.get("OfficialRating"),
        is_4k=bool(width and width >= 3000),
        is_3d=bool(raw.get("Video3DFormat")),
        is_favorite=bool(user_data.get("IsFavorite")),
        watched=bool(user_data.get("Played")),
        resume_percent=round(resume_percent, 1) if resume_percent else None,
        resume_seconds=resume_seconds,
        overview=raw.get("Overview"),
        tagline=taglines[0] if taglines else None,
        provider_ids=provider_ids,
        path=path,
        image_tag=(raw.get("ImageTags") or {}).get("Primary"),
        backdrop_tag=next(iter(raw.get("BackdropImageTags") or []), None),
        thumb_tag=(raw.get("ImageTags") or {}).get("Thumb"),
        banner_tag=(raw.get("ImageTags") or {}).get("Banner"),
        video_format=video_format,
        audio_format=audio_format,
        playable=playable,
        unplayable_reason=(
            None if playable else "Keine TMDB/IMDb-ID und kein Pfad — nicht abspielbar"
        ),
    )


def _stream_summary(
    raw: Mapping[str, Any],
) -> tuple[int | None, str | None, str | None]:
    streams = raw.get("MediaStreams")
    if not streams:
        sources = raw.get("MediaSources") or []
        streams = sources[0].get("MediaStreams", []) if sources else []

    width: int | None = None
    video_format: str | None = None
    audio_format: str | None = None
    for stream in streams or []:
        if stream.get("Type") == "Video" and video_format is None:
            width = stream.get("Width")
            bits = [
                f"{stream.get('Width')}×{stream.get('Height')}"
                if stream.get("Width")
                else None,
                f"@{stream['AverageFrameRate']:.3f}Hz"
                if stream.get("AverageFrameRate")
                else None,
                stream.get("VideoRange"),
            ]
            video_format = " · ".join(b for b in bits if b) or None
        elif stream.get("Type") == "Audio" and audio_format is None:
            bits = [
                stream.get("Codec", "").upper() or None,
                stream.get("ChannelLayout"),
                stream.get("Language"),
            ]
            audio_format = " · ".join(b for b in bits if b) or None
    return width, video_format, audio_format


def _apply_client_side_filters(
    items: list[MediaItem], query: MediaQuery
) -> list[MediaItem]:
    """
    Apply the one filter Jellyfin cannot express server-side.

    Countries live only in `ProductionLocations`, which `/Items` cannot
    filter on. Beware the cost: a client-side cut shrinks a page after
    pagination, so page totals and offsets stop lining up. Today this path
    is unreachable from the card — `facets()` supplies no countries, so the
    filter is never offered (FR-52) — and it must not gain new filters
    without solving the pagination accounting first.
    """
    if not query.countries:
        return items
    wanted = set(query.countries)
    return [i for i in items if wanted & set(i.countries)]
