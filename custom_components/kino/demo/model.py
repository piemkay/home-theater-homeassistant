"""
Demo-mode domain objects.

No Home Assistant import anywhere in this module, so clips, showcases and
the settings that govern replay are testable on a plain Python install
(NFR-6), exactly like the activity engine's own model.

Timestamps are milliseconds throughout — and never shown as milliseconds in
any UI. :func:`format_timecode` and :func:`parse_timecode` are the only two
places that translation happens.
"""

from __future__ import annotations

import re
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import Any

#: The curated tag vocabulary (spec §2.3). Free text is always allowed on
#: top of it; a recurring free tag can be promoted by adding it here.
VOCABULARY: tuple[tuple[str, str], ...] = (
    ("bass_heavy", "Bass"),
    ("atmos_heights", "Atmos-Höhen"),
    ("panning", "Panning"),
    ("dialogue", "Dialog"),
    ("hdr_blacks", "HDR-Schwarz"),
    ("hdr_highlights", "HDR-Lichter"),
    ("guest_safe", "Gästetauglich"),
    ("spoilers", "Spoiler"),
)

#: How the two advance modes of a showcase are spelled.
ADVANCE_AUTO = "auto"
ADVANCE_TAP = "tap"


def new_id(prefix: str) -> str:
    """Return a stable identity for a clip or a showcase."""
    return f"{prefix}{uuid.uuid4().hex[:12]}"


def format_timecode(milliseconds: float) -> str:
    """Render ms as ``H:MM:SS`` (or ``M:SS`` below the hour)."""
    total = max(0, round(milliseconds / 1000))
    hours, rest = divmod(total, 3600)
    minutes, seconds = divmod(rest, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{seconds:02d}"
    return f"{minutes}:{seconds:02d}"


def parse_timecode(text: str | float | None) -> int | None:
    """Read a human timecode into ms, forgivingly.

    ``1:12:04``, ``72:04`` and a bare ``4332`` all resolve; anything that is
    not a timecode at all returns None rather than a wrong number.
    """
    if text is None:
        return None
    if isinstance(text, (int, float)):
        return max(0, round(float(text) * 1000))
    parts = [p.strip() for p in str(text).strip().split(":")]
    if not parts or any(not re.fullmatch(r"\d+(\.\d+)?", p) for p in parts):
        return None
    seconds = 0.0
    for part in parts:
        seconds = seconds * 60 + float(part)
    return max(0, round(seconds * 1000))


def _clean_tags(values: Any) -> tuple[str, ...]:
    if not isinstance(values, Sequence) or isinstance(values, (str, bytes)):
        return ()
    seen: list[str] = []
    for value in values:
        tag = str(value).strip()
        if tag and tag not in seen:
            seen.append(tag)
    return tuple(seen)


def _opt_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _opt_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


@dataclass(frozen=True)
class Clip:
    """One reference span of one title — the atomic unit of demo mode."""

    id: str
    #: Primary media key. The catalogue's own item id.
    item_id: str | None = None
    #: The path as the catalogue reports it; the player's mapping is applied
    #: at play time, exactly as it is for an ordinary title.
    path: str | None = None
    #: Display, and the last-resort matcher after a library reorganisation.
    title: str = ""
    episode: str | None = None
    start_ms: int = 0
    end_ms: int = 0
    name: str = ""
    tags: tuple[str, ...] = ()
    notes: str = ""
    #: Per-clip track choice, stored as the label the player itself offered.
    audio_track: str | None = None
    subtitle_track: str | None = None
    #: Relative to the showcase's reference level.
    volume_offset_db: float | None = None
    trinnov_preset: str | None = None
    madvr_profile: str | None = None
    barco_profile: str | None = None
    expected_format: str | None = None
    created_at: str | None = None
    capture_meta: Mapping[str, Any] = field(default_factory=dict)

    @property
    def duration_ms(self) -> int:
        return max(0, self.end_ms - self.start_ms)

    @property
    def has_overrides(self) -> bool:
        return any(
            v is not None
            for v in (
                self.volume_offset_db,
                self.trinnov_preset,
                self.madvr_profile,
                self.barco_profile,
            )
        )

    def default_name(self) -> str:
        """Return the auto-generated name a fresh capture starts with."""
        span = f"{format_timecode(self.start_ms)}–{format_timecode(self.end_ms)}"
        return f"{self.title} — {span}" if self.title else span

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "itemId": self.item_id,
            "path": self.path,
            "title": self.title,
            "episode": self.episode,
            "startMs": self.start_ms,
            "endMs": self.end_ms,
            "durationMs": self.duration_ms,
            "start": format_timecode(self.start_ms),
            "end": format_timecode(self.end_ms),
            "duration": format_timecode(self.duration_ms),
            "name": self.name,
            "tags": list(self.tags),
            "notes": self.notes,
            "audioTrack": self.audio_track,
            "subtitleTrack": self.subtitle_track,
            "volumeOffsetDb": self.volume_offset_db,
            "trinnovPreset": self.trinnov_preset,
            "madvrProfile": self.madvr_profile,
            "barcoProfile": self.barco_profile,
            "expectedFormat": self.expected_format,
            "createdAt": self.created_at,
            "captureMeta": dict(self.capture_meta),
        }

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> Clip:
        start = int(raw.get("startMs") or raw.get("start_ms") or 0)
        end = int(raw.get("endMs") or raw.get("end_ms") or 0)
        if end < start:
            start, end = end, start
        clip = cls(
            id=str(raw.get("id") or new_id("c")),
            item_id=_opt_str(raw.get("itemId") or raw.get("item_id")),
            path=_opt_str(raw.get("path")),
            title=str(raw.get("title") or ""),
            episode=_opt_str(raw.get("episode")),
            start_ms=max(0, start),
            end_ms=max(0, end),
            name=str(raw.get("name") or "").strip(),
            tags=_clean_tags(raw.get("tags")),
            notes=str(raw.get("notes") or ""),
            audio_track=_opt_str(raw.get("audioTrack") or raw.get("audio_track")),
            subtitle_track=_opt_str(
                raw.get("subtitleTrack") or raw.get("subtitle_track")
            ),
            volume_offset_db=_opt_float(
                raw.get("volumeOffsetDb", raw.get("volume_offset_db"))
            ),
            trinnov_preset=_opt_str(
                raw.get("trinnovPreset") or raw.get("trinnov_preset")
            ),
            madvr_profile=_opt_str(raw.get("madvrProfile") or raw.get("madvr_profile")),
            barco_profile=_opt_str(raw.get("barcoProfile") or raw.get("barco_profile")),
            expected_format=_opt_str(
                raw.get("expectedFormat") or raw.get("expected_format")
            ),
            created_at=_opt_str(raw.get("createdAt") or raw.get("created_at")),
            capture_meta=dict(raw.get("captureMeta") or raw.get("capture_meta") or {}),
        )
        if not clip.name:
            clip = replace(clip, name=clip.default_name())
        return clip


@dataclass(frozen=True)
class Showcase:
    """An ordered playlist of clips that plays clip after clip."""

    id: str
    name: str = ""
    clip_ids: tuple[str, ...] = ()
    advance: str = ADVANCE_AUTO
    gap_seconds: int = 8
    reference_volume_db: float | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "clips": list(self.clip_ids),
            "advance": self.advance,
            "gapSeconds": self.gap_seconds,
            "referenceVolumeDb": self.reference_volume_db,
        }

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> Showcase:
        advance = str(raw.get("advance") or ADVANCE_AUTO)
        clips = raw.get("clips") or raw.get("clip_ids") or ()
        gap = int(raw.get("gapSeconds") or raw.get("gap_seconds") or 8)
        return cls(
            id=str(raw.get("id") or new_id("s")),
            name=str(raw.get("name") or "").strip(),
            clip_ids=tuple(str(c) for c in clips),
            advance=advance if advance in (ADVANCE_AUTO, ADVANCE_TAP) else ADVANCE_AUTO,
            gap_seconds=max(0, min(60, gap)),
            reference_volume_db=_opt_float(
                raw.get("referenceVolumeDb", raw.get("reference_volume_db"))
            ),
        )


@dataclass(frozen=True)
class DemoSettings:
    """Install-wide knobs the replay engine reads (spec §4.1, §8)."""

    #: The signal chain needs this long after a seek before picture and sound
    #: are locked, so the engine starts the clip that much early and lets the
    #: handshake burn off. Stored timestamps always mark the artistic start.
    lead_in_seconds: float = 8.0
    #: "That was demo-worthy": how far back the retro capture reaches.
    retro_capture_seconds: int = 60
    #: Mute through the lead-in and come up at the artistic start.
    mute_during_lead_in: bool = False
    #: Ramp the last moments down so a hard cut out of loud material is soft.
    ramp_out: bool = False
    #: A/B and override gaps wait for the hardware to confirm — but never
    #: longer than this, so a missed confirmation cannot hang a demo.
    confirm_timeout_seconds: float = 15.0
    #: Warn when the processor's reported format differs from the clip's
    #: `expected_format` (spec §8, flag-gated).
    preflight_format_check: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {
            "leadInSeconds": self.lead_in_seconds,
            "retroCaptureSeconds": self.retro_capture_seconds,
            "muteDuringLeadIn": self.mute_during_lead_in,
            "rampOut": self.ramp_out,
            "confirmTimeoutSeconds": self.confirm_timeout_seconds,
            "preflightFormatCheck": self.preflight_format_check,
        }

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any] | None) -> DemoSettings:
        raw = raw or {}
        base = cls()

        def num(camel: str, snake: str, fallback: float) -> float:
            value = _opt_float(raw.get(camel, raw.get(snake)))
            return fallback if value is None else value

        def flag(camel: str, snake: str, fallback: bool) -> bool:
            value = raw.get(camel, raw.get(snake))
            return fallback if value is None else bool(value)

        lead_in = num("leadInSeconds", "lead_in_seconds", base.lead_in_seconds)
        retro = num(
            "retroCaptureSeconds", "retro_capture_seconds", base.retro_capture_seconds
        )
        confirm = num(
            "confirmTimeoutSeconds",
            "confirm_timeout_seconds",
            base.confirm_timeout_seconds,
        )
        return cls(
            lead_in_seconds=max(0.0, min(60.0, lead_in)),
            retro_capture_seconds=int(max(5, min(600, retro))),
            mute_during_lead_in=flag(
                "muteDuringLeadIn", "mute_during_lead_in", base.mute_during_lead_in
            ),
            ramp_out=flag("rampOut", "ramp_out", base.ramp_out),
            confirm_timeout_seconds=max(1.0, min(60.0, confirm)),
            preflight_format_check=flag(
                "preflightFormatCheck",
                "preflight_format_check",
                base.preflight_format_check,
            ),
        )
