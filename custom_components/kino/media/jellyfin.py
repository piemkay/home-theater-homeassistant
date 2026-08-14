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
import time
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
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
    MediaTrack,
    Person,
    SortOrder,
    Trailer,
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
        "CriticRating",
        "UserData",
        "RunTimeTicks",
        "ProductionYear",
        "PremiereDate",
        "DateCreated",
    )
)

#: The single-item detail additionally carries cast, crew and trailers; grids
#: do not.
_DETAIL_FIELDS = f"{_MOVIE_FIELDS},People,RemoteTrailers"

#: What the filter-count scan needs per title — no images, no media sources.
_SCAN_FIELDS = ",".join(  # noqa: FLY002 - a long, readable field list
    (
        "Genres",
        "MediaStreams",
        "ProductionYear",
        "OfficialRating",
        "CommunityRating",
        "CriticRating",
        "UserData",
    )
)

#: A series carries no streams of its own — its languages live one level down,
#: in the episodes. This is all that pass needs to read.
_EPISODE_LANG_FIELDS = "MediaStreams"

#: Upper bound for one scan page — far above any home library, so one request
#: really is the whole catalogue.
_SCAN_LIMIT = 5000

#: How long one scan may serve counts. Toggling chips in the filter sheet
#: recounts several times in a few seconds; the library does not change while
#: someone is doing that.
_SCAN_TTL_SECONDS = 30.0

#: The episode sweep behind the series language facets is the one expensive
#: read in this client (thousands of episodes, every stream on each). What it
#: answers — "which languages does this series exist in" — changes when files
#: are added, not while someone taps chips, so it is cached far longer.
_EPISODE_INDEX_TTL_SECONDS = 900.0

#: …and it is allowed to take far longer than an ordinary read.
_EPISODE_SWEEP_TIMEOUT = 90.0

#: Stream titles that mark a track as *about* the film rather than a way to
#: watch it. Jellyfin has no flag for this, so the title is the only signal.
_COMMENTARY_PATTERN = re.compile(
    r"(?i)\b(commentar\w*|kommentar\w*|audio\s*descri\w*|audiodeskription|"
    r"described\s+video|narration)\b"
)

#: ISO-639-2/T codes Jellyfin sometimes emits, folded onto the /B twins the
#: rest of the library uses, so "deu" and "ger" count as one language.
_LANG_SYNONYMS = {
    "deu": "ger",
    "fra": "fre",
    "zho": "chi",
    "ces": "cze",
    "nld": "dut",
    "ell": "gre",
    "isl": "ice",
    "fas": "per",
    "ron": "rum",
    "slk": "slo",
    "sqi": "alb",
    "hye": "arm",
    "eus": "baq",
    "kat": "geo",
    "msa": "may",
    "mya": "bur",
    "cym": "wel",
    "nob": "nor",
    "nno": "nor",
}

#: Two-letter ISO-639-1 codes, folded onto the same /B twins. Files tagged by
#: different tools land in different standards, and the live library really
#: does carry "en" beside "eng" and "zh-hans" beside "chi" — three spellings
#: of one language is three chips that each find a third of the titles.
_LANG_ISO1 = {
    "aa": "aar", "ab": "abk", "af": "afr", "ak": "aka", "am": "amh",
    "ar": "ara", "as": "asm", "az": "aze", "ba": "bak", "be": "bel",
    "bg": "bul", "bn": "ben", "bo": "tib", "br": "bre", "bs": "bos",
    "ca": "cat", "cs": "cze", "cy": "wel", "da": "dan", "de": "ger",
    "dv": "div", "dz": "dzo", "el": "gre", "en": "eng", "eo": "epo",
    "es": "spa", "et": "est", "eu": "baq", "fa": "per", "fi": "fin",
    "fj": "fij", "fo": "fao", "fr": "fre", "fy": "fry", "ga": "gle",
    "gd": "gla", "gl": "glg", "gu": "guj", "ha": "hau", "he": "heb",
    "hi": "hin", "hr": "hrv", "ht": "hat", "hu": "hun", "hy": "arm",
    "id": "ind", "is": "ice", "it": "ita", "iu": "iku", "ja": "jpn",
    "jv": "jav", "ka": "geo", "kk": "kaz", "km": "khm", "kn": "kan",
    "ko": "kor", "ku": "kur", "ky": "kir", "la": "lat", "lb": "ltz",
    "lo": "lao", "lt": "lit", "lv": "lav", "mg": "mlg", "mi": "mao",
    "mk": "mac", "ml": "mal", "mn": "mon", "mr": "mar", "ms": "may",
    "mt": "mlt", "my": "bur", "nb": "nor", "ne": "nep", "nl": "dut",
    "nn": "nor", "no": "nor", "oc": "oci", "or": "ori", "pa": "pan",
    "pl": "pol", "ps": "pus", "pt": "por", "qu": "que", "rm": "roh",
    "ro": "rum", "ru": "rus", "sa": "san", "si": "sin", "sk": "slo",
    "sl": "slv", "so": "som", "sq": "alb", "sr": "srp", "sv": "swe",
    "sw": "swa", "ta": "tam", "te": "tel", "tg": "tgk", "th": "tha",
    "tk": "tuk", "tl": "tgl", "tr": "tur", "tt": "tat", "uk": "ukr",
    "ur": "urd", "uz": "uzb", "vi": "vie", "yi": "yid", "yo": "yor",
    "zh": "chi", "zu": "zul",
}  # fmt: skip

#: One more /T-to-/B pair the live library turned up.
_LANG_SYNONYMS["mkd"] = "mac"

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
        #: (item types, search, persons, sort) -> (monotonic time, records).
        self._scan_cache: dict[tuple, tuple[float, list[_ScanRecord]]] = {}
        #: (monotonic time, series id -> (audio langs, subtitle langs)).
        self._episode_index: tuple[float, dict[str, _LangPair]] | None = None

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
        timeout: float | None = None,
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
                timeout=timeout if timeout is not None else self._timeout,
            )
        # Two distinct classes on Python 3.10, which CI still runs; they only
        # became the same exception in 3.11.
        except (TimeoutError, asyncio.TimeoutError) as err:
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
        # Filters Jellyfin cannot express — several genres that must ALL
        # match, track languages, and a critics minimum (10.11 accepts
        # MinCriticRating and then ignores it, verified live) — go through
        # the scan: filter the whole catalogue by ID first, then fetch just
        # the visible page. That keeps totals and offsets exact (the trap
        # `_apply_client_side_filters` documents).
        if (
            len(query.genres) > 1
            or len(query.person_ids) > 1
            or query.audio_langs
            or query.subtitle_langs
            or query.min_critic is not None
        ):
            return await self._search_scanned(query)
        user = self._require_user()
        params = _search_params(query)
        payload = await self._request("GET", f"/Users/{user}/Items", params=params)
        raw_items = (payload or {}).get("Items") or []
        total = int((payload or {}).get("TotalRecordCount", len(raw_items)))

        items = [_to_item(raw) for raw in raw_items]
        items = _apply_client_side_filters(items, query)
        return MediaPage(items=tuple(items), total=total, offset=query.offset)

    async def _search_scanned(self, query: MediaQuery) -> MediaPage:
        """Search via the catalogue scan: exact totals for Python-side filters."""
        user = self._require_user()
        records = await self._scan(query)
        ids = [record.id for record in records if _matches(record, query)]
        page_ids = ids[query.offset : query.offset + query.limit]
        if not page_ids:
            return MediaPage(items=(), total=len(ids), offset=query.offset)
        payload = await self._request(
            "GET",
            f"/Users/{user}/Items",
            params={"Ids": ",".join(page_ids), "Fields": _MOVIE_FIELDS},
        )
        by_id = {
            item.id: item
            for item in (_to_item(raw) for raw in (payload or {}).get("Items") or [])
        }
        # The Ids fetch does not promise the scan's sort order — restore it.
        items = tuple(by_id[i] for i in page_ids if i in by_id)
        return MediaPage(items=items, total=len(ids), offset=query.offset)

    async def item(self, item_id: str) -> MediaItem | None:
        user = self._require_user()
        payload = await self._request(
            "GET",
            f"/Users/{user}/Items/{quote(item_id)}",
            params={"Fields": _DETAIL_FIELDS},
        )
        return _to_item(payload) if payload else None

    async def similar(self, item_id: str, limit: int = 12) -> Sequence[MediaItem]:
        """Jellyfin's own "More Like This" list for one title."""
        user = self._require_user()
        payload = await self._request(
            "GET",
            f"/Items/{quote(item_id)}/Similar",
            params={"UserId": user, "Limit": limit, "Fields": _MOVIE_FIELDS},
        )
        items = [_to_item(raw) for raw in (payload or {}).get("Items") or []]
        # Jellyfin 10.11 hands back more than the Limit it was asked for
        # (verified live) — the row must not grow with the server's mood.
        return items[:limit]

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

    async def _scan(self, query: MediaQuery) -> list[_ScanRecord]:
        """One slim pass over everything the category and search term match.

        Group filters (genres, ratings, languages, tags…) are deliberately
        NOT applied here — the records must stay relaxable so `facet_counts`
        can answer "and what if this chip were on too?" for every value.
        A short cache keeps chip-toggling in the filter sheet at one Jellyfin
        request instead of one per tap.
        """
        user = self._require_user()
        item_types = _item_types(query.category)
        sort_by, sort_order = _SORT_FIELDS[query.sort]
        if query.sort_dir:
            sort_order = "Ascending" if query.sort_dir == "asc" else "Descending"
        key = (item_types, query.search or "", query.person_ids, sort_by, sort_order)

        now = time.monotonic()
        cached = self._scan_cache.get(key)
        if cached and now - cached[0] < _SCAN_TTL_SECONDS:
            return cached[1]

        params: dict[str, Any] = {
            "Recursive": True,
            "IncludeItemTypes": item_types,
            "SortBy": sort_by,
            "SortOrder": sort_order,
            "Limit": _SCAN_LIMIT,
            "Fields": _SCAN_FIELDS,
            "EnableImages": False,
            "EnableTotalRecordCount": False,
        }
        if query.search:
            params["SearchTerm"] = query.search
        # One name narrows server-side and is exact. Several do not: Jellyfin
        # neither ANDs nor ORs a `|`-joined PersonIds — asked for Tom Holland
        # and Zendaya it returned 643 of 620 films, i.e. the filter fell off
        # entirely (verified live). Several names are intersected below.
        if len(query.person_ids) == 1:
            params["PersonIds"] = query.person_ids[0]
        payload = await self._request("GET", f"/Users/{user}/Items", params=params)
        records = [_to_record(raw) for raw in (payload or {}).get("Items") or []]
        if len(query.person_ids) > 1:
            credited = await self._credited_by_all(query.person_ids, item_types)
            records = [record for record in records if record.id in credited]
        # A series has no streams of its own; its languages are its episodes'.
        if "Series" in item_types:
            records = await self._with_episode_languages(records)

        # Drop expired entries so alternating categories cannot grow the map.
        self._scan_cache = {
            k: v for k, v in self._scan_cache.items() if now - v[0] < _SCAN_TTL_SECONDS
        }
        self._scan_cache[key] = (now, records)
        return records

    async def _credited_by_all(
        self, person_ids: tuple[str, ...], item_types: str
    ) -> frozenset[str]:
        """IDs of the titles that credit *every* one of these people.

        Two stacked names mean "with both of them" — the same reading that
        makes stacked genre chips narrow rather than widen. Jellyfin cannot
        express it, so each name is asked for on its own and the answers are
        intersected: one small ID-only request per name, and the first empty
        intersection ends it.
        """
        user = self._require_user()
        credited: set[str] | None = None
        for person_id in person_ids:
            payload = await self._request(
                "GET",
                f"/Users/{user}/Items",
                params={
                    "Recursive": True,
                    "IncludeItemTypes": item_types,
                    "PersonIds": person_id,
                    "Limit": _SCAN_LIMIT,
                    "EnableImages": False,
                    "EnableUserData": False,
                    "EnableTotalRecordCount": False,
                },
            )
            ids = {
                str(raw["Id"])
                for raw in (payload or {}).get("Items") or []
                if raw.get("Id")
            }
            credited = ids if credited is None else credited & ids
            if not credited:
                break
        return frozenset(credited or ())

    async def _with_episode_languages(
        self, records: list[_ScanRecord]
    ) -> list[_ScanRecord]:
        """Lend every series the languages its episodes actually carry.

        Without this the Tonspur and Untertitel groups are simply empty under
        Serien — 121 shows, no languages, no explanation. The index behind it
        is one sweep over the episodes, cached far longer than a scan, and a
        failure is not fatal: the series keep the languages they had (none).
        """
        if not any(record.is_series for record in records):
            return records
        try:
            index = await self._episode_language_index()
        except MediaBackendError:
            _LOGGER.debug("Folgen-Sprachindex fehlgeschlagen", exc_info=True)
            return records
        if not index:
            return records
        lent = []
        for record in records:
            pair = index.get(record.id) if record.is_series else None
            lent.append(
                record
                if pair is None
                else replace(record, langs=pair[0], sub_langs=pair[1])
            )
        return lent

    async def _episode_language_index(self) -> dict[str, _LangPair]:
        """Per series: the union of its episodes' audio and subtitle languages."""
        now = time.monotonic()
        cached = self._episode_index
        if cached and now - cached[0] < _EPISODE_INDEX_TTL_SECONDS:
            return cached[1]

        user = self._require_user()
        payload = await self._request(
            "GET",
            f"/Users/{user}/Items",
            params={
                "Recursive": True,
                "IncludeItemTypes": "Episode",
                "Limit": _SCAN_LIMIT,
                "Fields": _EPISODE_LANG_FIELDS,
                "EnableImages": False,
                "EnableUserData": False,
                "EnableTotalRecordCount": False,
            },
            # Every episode with every stream on it: ~7 s for 2 962 episodes
            # here, which already eats half the ordinary budget. This one read
            # gets room to grow rather than silently timing out and taking the
            # series language facets down with it.
            timeout=_EPISODE_SWEEP_TIMEOUT,
        )
        audio: dict[str, set[str]] = {}
        subs: dict[str, set[str]] = {}
        for raw in (payload or {}).get("Items") or []:
            series_id = raw.get("SeriesId")
            if not series_id:
                continue
            langs, sub_langs = _stream_languages(raw)
            audio.setdefault(str(series_id), set()).update(langs)
            subs.setdefault(str(series_id), set()).update(sub_langs)
        index = {
            series_id: (frozenset(langs), frozenset(subs.get(series_id, ())))
            for series_id, langs in audio.items()
        }
        self._episode_index = (now, index)
        return index

    async def facet_counts(self, query: MediaQuery) -> dict[str, Any]:
        """Per filter value: the result count after tapping that chip.

        Toggle semantics throughout — an inactive value is counted as if
        added to the current selection, an active one as if removed — so the
        number on a chip always says what the grid would show next.
        """
        records = await self._scan(query)
        current = [record for record in records if _matches(record, query)]

        genre_values = {g for record in records for g in record.genres}
        rating_values = {r for record in records if (r := record.official)}
        lang_values = {lang for record in records for lang in record.langs}
        sub_values = {lang for record in records for lang in record.sub_langs}

        def count(candidate: MediaQuery) -> int:
            return sum(1 for record in records if _matches(record, candidate))

        return {
            "total": len(current),
            "genres": {
                value: count(replace(query, genres=_toggled(query.genres, value)))
                for value in genre_values
            },
            "ratings": {
                value: count(replace(query, ratings=_toggled(query.ratings, value)))
                for value in rating_values
            },
            "audioLangs": {
                value: count(
                    replace(query, audio_langs=_toggled(query.audio_langs, value))
                )
                for value in lang_values
            },
            "subtitleLangs": {
                value: count(
                    replace(query, subtitle_langs=_toggled(query.subtitle_langs, value))
                )
                for value in sub_values
            },
            "tags": {flag: count(_toggle_flag(query, flag)) for flag in _TAG_FLAGS},
        }

    async def persons(self, query: str, limit: int = 20) -> Sequence[Person]:
        """Cast and crew whose name matches, for the people filter.

        `/Persons` searches the catalogue's own people, so the field can only
        ever offer names that will actually return something.
        """
        term = (query or "").strip()
        if not term:
            return ()
        payload = await self._request(
            "GET",
            "/Persons",
            params={
                "UserId": self._user_id,
                "SearchTerm": term,
                "Limit": limit,
                "Recursive": True,
            },
        )
        return tuple(
            _to_person(raw)
            for raw in (payload or {}).get("Items") or []
            if raw.get("Id")
        )

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
        # Track languages exist nowhere in /Items/Filters — they come from the
        # scans, most common first. Films and series both contribute: a series'
        # languages are lent to it from its episodes (`_with_episode_languages`).
        langs: Counter[str] = Counter()
        sub_langs: Counter[str] = Counter()
        for category in (Category.MOVIES, Category.SHOWS):
            try:
                for record in await self._scan(MediaQuery(category=category)):
                    langs.update(record.langs)
                    sub_langs.update(record.sub_langs)
            except MediaBackendError:
                _LOGGER.debug("Sprach-Scan fehlgeschlagen", exc_info=True)
        return Facets(
            genres=genres,
            ratings=ratings,
            audio_languages=_ranked_languages(langs),
            subtitle_languages=_ranked_languages(sub_langs),
            year_min=min(years) if years else None,
            year_max=max(years) if years else None,
        )

    async def refresh(self) -> None:
        """Ask Jellyfin to rescan (FR-44)."""
        self._scan_cache.clear()
        self._episode_index = None
        await self._request("POST", "/Library/Refresh")

    async def set_favorite(self, item_id: str, favorite: bool) -> None:
        """Mark or unmark a favourite for the connected user."""
        user = self._require_user()
        method = "POST" if favorite else "DELETE"
        await self._request(method, f"/Users/{user}/FavoriteItems/{quote(item_id)}")
        self._scan_cache.clear()

    async def set_watched(self, item_id: str, watched: bool) -> None:
        """Mark or unmark one entry as watched, for the connected user.

        Jellyfin takes a season or a series here as readily as an episode and
        cascades the flag down, which is exactly what "Staffel gesehen" means.
        The cached scans still hold the old flag, so they are dropped: the grid
        behind the sheet must not keep claiming the opposite.
        """
        user = self._require_user()
        method = "POST" if watched else "DELETE"
        await self._request(method, f"/Users/{user}/PlayedItems/{quote(item_id)}")
        self._scan_cache.clear()

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


def _item_types(category: Category) -> str:
    """Which Jellyfin item types one browse category covers."""
    # The home rows (recent, continue, favorites) should show both kinds.
    if category is Category.SHOWS:
        return "Series"
    if category in (Category.RECENT, Category.CONTINUE, Category.FAVORITES):
        return "Movie,Series"
    return "Movie"


def _search_params(  # noqa: C901, PLR0912 - a flat translation table, one branch per filter
    query: MediaQuery,
) -> dict[str, Any]:
    """Translate one :class:`MediaQuery` into `/Items` query parameters."""
    sort_by, sort_order = _SORT_FIELDS[query.sort]
    params: dict[str, Any] = {
        "Recursive": True,
        "Fields": _MOVIE_FIELDS,
        "IncludeItemTypes": _item_types(query.category),
        "SortBy": sort_by,
        "SortOrder": sort_order,
        "Limit": query.limit,
        "StartIndex": query.offset,
        "EnableTotalRecordCount": True,
    }
    if query.search:
        params["SearchTerm"] = query.search
    # A single genre is the same under OR and AND; several genres never reach
    # this translation — `search()` routes them through the scan.
    if query.genres:
        params["Genres"] = "|".join(query.genres)
    if query.person_ids:
        params["PersonIds"] = "|".join(query.person_ids)
    if query.min_rating is not None:
        params["MinCommunityRating"] = query.min_rating
    # No MinCriticRating here: the server accepts it and ignores it, so a
    # critics minimum never reaches this translation — `search()` routes it
    # through the scan.
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
    if query.only_favorites or query.category is Category.FAVORITES:
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
    audio_tracks, subtitle_tracks = _to_tracks(raw)
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
        critic_rating=raw.get("CriticRating"),
        official_rating=raw.get("OfficialRating"),
        is_4k=bool(width and width >= 3000),
        is_3d=bool(raw.get("Video3DFormat")),
        is_favorite=bool(user_data.get("IsFavorite")),
        watched=bool(user_data.get("Played")),
        resume_percent=round(resume_percent, 1) if resume_percent else None,
        resume_seconds=resume_seconds,
        overview=raw.get("Overview"),
        tagline=taglines[0] if taglines else None,
        people=tuple(_to_person(p) for p in raw.get("People") or () if p.get("Id")),
        provider_ids=provider_ids,
        path=path,
        image_tag=(raw.get("ImageTags") or {}).get("Primary"),
        backdrop_tag=next(iter(raw.get("BackdropImageTags") or []), None),
        thumb_tag=(raw.get("ImageTags") or {}).get("Thumb"),
        banner_tag=(raw.get("ImageTags") or {}).get("Banner"),
        video_format=video_format,
        audio_format=audio_format,
        audio_tracks=audio_tracks,
        subtitle_tracks=subtitle_tracks,
        trailers=tuple(
            _to_trailer(t) for t in raw.get("RemoteTrailers") or () if t.get("Url")
        ),
        playable=playable,
        unplayable_reason=(
            None if playable else "Keine TMDB/IMDb-ID und kein Pfad — nicht abspielbar"
        ),
    )


def _to_person(raw: Mapping[str, Any]) -> Person:
    # `/Persons` answers with Type="Person" — a person's *kind* only exists in
    # the context of a title, so the search results carry no role at all.
    return Person(
        id=str(raw.get("Id", "")),
        name=str(raw.get("Name") or ""),
        kind=str(raw.get("Type") or "Actor"),
        role=raw.get("Role") or None,
        image_tag=(raw.get("ImageTags") or {}).get("Primary")
        or raw.get("PrimaryImageTag"),
    )


def _to_trailer(raw: Mapping[str, Any]) -> Trailer:
    return Trailer(name=str(raw.get("Name") or "Trailer"), url=str(raw.get("Url")))


def _streams(raw: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    """Every stream of a title, wherever this response happens to carry them."""
    streams = raw.get("MediaStreams")
    if not streams:
        sources = raw.get("MediaSources") or []
        streams = sources[0].get("MediaStreams", []) if sources else []
    return list(streams or [])


def _is_commentary(stream: Mapping[str, Any]) -> bool:
    """Report whether a track is *about* the film rather than a way to watch it."""
    for field in ("Title", "DisplayTitle"):
        value = stream.get(field)
        if isinstance(value, str) and _COMMENTARY_PATTERN.search(value):
            return True
    return False


def _to_track(stream: Mapping[str, Any]) -> MediaTrack:
    title = stream.get("Title") or stream.get("DisplayTitle")
    return MediaTrack(
        index=int(stream.get("Index") or 0),
        language=_normalize_lang(stream.get("Language")),
        codec=(stream.get("Codec") or None) and str(stream["Codec"]).upper(),
        channel_layout=stream.get("ChannelLayout"),
        title=str(title) if title else None,
        is_default=bool(stream.get("IsDefault")),
        is_forced=bool(stream.get("IsForced")),
        is_commentary=_is_commentary(stream),
    )


def _to_tracks(
    raw: Mapping[str, Any],
) -> tuple[tuple[MediaTrack, ...], tuple[MediaTrack, ...]]:
    """Split one title's streams into its audio and its subtitle tracks."""
    audio: list[MediaTrack] = []
    subtitles: list[MediaTrack] = []
    for stream in _streams(raw):
        kind = stream.get("Type")
        if kind == "Audio":
            audio.append(_to_track(stream))
        elif kind == "Subtitle":
            subtitles.append(_to_track(stream))
    return tuple(audio), tuple(subtitles)


def _stream_languages(raw: Mapping[str, Any]) -> tuple[frozenset[str], frozenset[str]]:
    """Return the audio and subtitle languages one title can be watched in.

    Commentary and audio-description tracks are left out: a film with a
    German dub and an English director's commentary is a German film, and
    saying otherwise is what made the Tonspur filter untrustworthy.
    """
    langs: set[str] = set()
    sub_langs: set[str] = set()
    for stream in _streams(raw):
        lang = _normalize_lang(stream.get("Language"))
        if not lang or lang in _NON_LANGUAGES or _is_commentary(stream):
            continue
        if stream.get("Type") == "Audio":
            langs.add(lang)
        elif stream.get("Type") == "Subtitle":
            sub_langs.add(lang)
    return frozenset(langs), frozenset(sub_langs)


def _ranked_languages(counts: Counter[str]) -> tuple[str, ...]:
    """Language codes, most common first."""
    return tuple(code for code, _ in counts.most_common())


#: "und" is undetermined, "zxx" is no-linguistic-content (score-only tracks) —
#: neither is a language anyone filters for.
_NON_LANGUAGES = frozenset({"und", "zxx"})


def _normalize_lang(code: Any) -> str | None:
    """Fold one stream's language onto a single lowercase ISO-639-2 code.

    Files arrive tagged by whatever tool wrote them: "ger", "deu", "de" and
    "de-DE" are one language, and a filter that offers all four finds a
    quarter of the titles under each.
    """
    if not code or not isinstance(code, str):
        return None
    value = code.strip().lower()
    if not value:
        return None
    # "zh-hans", "pt-BR": the script or region says nothing about which
    # language a person is looking for.
    base = re.split(r"[-_]", value, maxsplit=1)[0]
    value = _LANG_ISO1.get(base, base)
    return _LANG_SYNONYMS.get(value, value)


#: A series' (audio languages, subtitle languages), lent from its episodes.
_LangPair = tuple[frozenset[str], frozenset[str]]


@dataclass(frozen=True)
class _ScanRecord:
    """One title, boiled down to what the filter predicates read."""

    id: str
    genres: frozenset[str]
    langs: frozenset[str]
    sub_langs: frozenset[str]
    year: int | None
    official: str | None
    rating: float | None
    critic: float | None
    width: int | None
    is_3d: bool
    watched: bool
    favorite: bool
    resumable: bool
    #: Series carry no streams of their own — `_with_episode_languages` fills
    #: theirs in afterwards, and needs to know which records to fill.
    is_series: bool = False


def _to_record(raw: Mapping[str, Any]) -> _ScanRecord:
    user_data = raw.get("UserData") or {}
    width: int | None = None
    for stream in _streams(raw):
        if stream.get("Type") == "Video":
            width = stream.get("Width")
            break
    langs, sub_langs = _stream_languages(raw)
    return _ScanRecord(
        id=str(raw.get("Id", "")),
        genres=frozenset(raw.get("Genres") or ()),
        langs=langs,
        sub_langs=sub_langs,
        year=raw.get("ProductionYear"),
        official=raw.get("OfficialRating"),
        rating=raw.get("CommunityRating"),
        critic=raw.get("CriticRating"),
        width=width,
        is_3d=bool(raw.get("Video3DFormat")),
        watched=bool(user_data.get("Played")),
        favorite=bool(user_data.get("IsFavorite")),
        resumable=bool(user_data.get("PlaybackPositionTicks")),
        is_series=raw.get("Type") == "Series",
    )


def _matches(  # noqa: C901, PLR0912 - a flat predicate, one clause per filter
    record: _ScanRecord, query: MediaQuery
) -> bool:
    """Mirror `_search_params` in Python: same filters, same semantics.

    One deliberate difference — several genres must ALL match here, because
    that is what stacked chips mean to a person; Jellyfin's parameter widens.
    """
    if query.genres and not set(query.genres) <= record.genres:
        return False
    if query.ratings and record.official not in query.ratings:
        return False
    if query.audio_langs and not set(query.audio_langs) & record.langs:
        return False
    if query.subtitle_langs and not set(query.subtitle_langs) & record.sub_langs:
        return False
    if query.year_from is not None and (
        record.year is None or record.year < query.year_from
    ):
        return False
    if query.year_to is not None and (
        record.year is None or record.year > query.year_to
    ):
        return False
    if (query.only_4k or query.category is Category.UHD) and not (
        record.width and record.width >= 3000
    ):
        return False
    if query.only_hd and not (record.width and 1280 <= record.width < 3000):
        return False
    if query.only_sd and not (record.width and record.width < 1280):
        return False
    if query.only_3d and not record.is_3d:
        return False
    if (
        query.only_unwatched or query.category is Category.UNWATCHED
    ) and record.watched:
        return False
    if query.only_watched and not record.watched:
        return False
    if (
        query.only_resumable or query.category is Category.CONTINUE
    ) and not record.resumable:
        return False
    if (
        query.only_favorites or query.category is Category.FAVORITES
    ) and not record.favorite:
        return False
    if query.min_rating is not None and (
        record.rating is None or record.rating < query.min_rating
    ):
        return False
    return not (
        query.min_critic is not None
        and (record.critic is None or record.critic < query.min_critic)
    )


def _toggled(current: tuple[str, ...], value: str) -> tuple[str, ...]:
    """One multi-select chip tapped: in the set → out, out → in."""
    if value in current:
        return tuple(v for v in current if v != value)
    return (*current, value)


#: The Format-&-Status flags, with their exclusivity groups — a title has one
#: resolution tier, and Gesehen/Nicht gesehen contradict each other. Mirrors
#: the card's `toggleTag`.
_TAG_FLAGS = (
    "only_4k",
    "only_hd",
    "only_sd",
    "only_3d",
    "only_resumable",
    "only_unwatched",
    "only_watched",
    "only_favorites",
)
_TAG_EXCLUSIVE = (
    ("only_4k", "only_hd", "only_sd"),
    ("only_unwatched", "only_watched"),
)


def _toggle_flag(query: MediaQuery, flag: str) -> MediaQuery:
    """One Format-&-Status chip tapped, exclusivity included."""
    turning_on = not getattr(query, flag)
    changes: dict[str, bool] = {flag: turning_on}
    if turning_on:
        for group in _TAG_EXCLUSIVE:
            if flag in group:
                changes.update({other: False for other in group if other != flag})
    return replace(query, **changes)


def _stream_summary(
    raw: Mapping[str, Any],
) -> tuple[int | None, str | None, str | None]:
    width: int | None = None
    video_format: str | None = None
    audio_format: str | None = None
    for stream in _streams(raw):
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
