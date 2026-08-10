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

import logging
from collections.abc import Mapping, Sequence
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

_SORT_FIELDS: dict[SortOrder, tuple[str, str]] = {
    SortOrder.ADDED: ("DateCreated", "Descending"),
    SortOrder.TITLE: ("SortName", "Ascending"),
    SortOrder.YEAR: ("ProductionYear", "Descending"),
    SortOrder.RATING: ("CommunityRating", "Descending"),
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
        except TimeoutError as err:
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
        sort_by, sort_order = _SORT_FIELDS[query.sort]

        params: dict[str, Any] = {
            "Recursive": True,
            "Fields": _MOVIE_FIELDS,
            "IncludeItemTypes": "Series"
            if query.category is Category.SHOWS
            else "Movie",
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
        if query.countries:
            # Jellyfin has no first-class country filter, so this is applied
            # client-side below rather than pretended away here.
            pass
        if query.year_from or query.year_to:
            years = _year_range(query.year_from, query.year_to)
            if years:
                params["Years"] = ",".join(str(y) for y in years)
        if query.only_unwatched or query.category is Category.UNWATCHED:
            params["Filters"] = "IsUnplayed"
        if query.only_resumable or query.category is Category.CONTINUE:
            params["Filters"] = "IsResumable"
        if query.category is Category.RECENT or query.only_recent:
            params["SortBy"] = "DateCreated"
            params["SortOrder"] = "Descending"

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

    async def latest(self, limit: int = 12) -> Sequence[MediaItem]:
        user = self._require_user()
        payload = await self._request(
            "GET",
            f"/Users/{user}/Items/Latest",
            params={
                "Limit": limit,
                "Fields": _MOVIE_FIELDS,
                "IncludeItemTypes": "Movie",
            },
        )
        return [_to_item(raw) for raw in (payload or [])]

    async def facets(self) -> Facets:
        user = self._require_user()
        payload = await self._request(
            "GET", "/Genres", params={"UserId": user, "Recursive": True}
        )
        genres = tuple(
            sorted(g.get("Name", "") for g in (payload or {}).get("Items") or [])
        )
        return Facets(genres=tuple(g for g in genres if g))

    async def refresh(self) -> None:
        """Ask Jellyfin to rescan (FR-44)."""
        await self._request("POST", "/Library/Refresh")

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


def _year_range(start: int | None, end: int | None) -> list[int]:
    if start is None and end is None:
        return []
    low = start or end
    high = end or start
    if low is None or high is None or high < low or high - low > 150:
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

    return MediaItem(
        id=str(raw.get("Id", "")),
        title=str(raw.get("Name") or "Ohne Titel"),
        kind="show" if raw.get("Type") == "Series" else "movie",
        year=raw.get("ProductionYear"),
        runtime_minutes=runtime,
        genres=tuple(raw.get("Genres") or ()),
        countries=tuple(raw.get("ProductionLocations") or ()),
        rating=raw.get("CommunityRating"),
        is_4k=bool(width and width >= 3000),
        watched=bool(user_data.get("Played")),
        resume_percent=round(resume_percent, 1) if resume_percent else None,
        resume_seconds=resume_seconds,
        overview=raw.get("Overview"),
        tagline=taglines[0] if taglines else None,
        provider_ids=provider_ids,
        path=path,
        image_tag=(raw.get("ImageTags") or {}).get("Primary"),
        backdrop_tag=next(iter(raw.get("BackdropImageTags") or []), None),
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
    Apply the filters Jellyfin cannot express server-side.

    Kept explicit rather than silently dropped, so the card never offers a
    filter that does nothing (FR-52).
    """
    result = items
    if query.countries:
        wanted = set(query.countries)
        result = [i for i in result if wanted & set(i.countries)]
    if query.only_4k:
        result = [i for i in result if i.is_4k]
    if query.only_hd:
        result = [i for i in result if not i.is_4k]
    return result
